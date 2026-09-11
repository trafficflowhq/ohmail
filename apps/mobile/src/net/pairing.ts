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
 * ── THE NO-SECURE-CONTEXT WIN, STATED — AND THE CLEARTEXT LOSS THAT CAME WITH IT ────────────
 *
 * The served BROWSER client carries three [SecureContext] dependencies that make a LAN origin
 * unusable there — which is why the desktop's LAN door serves an explainer, not the client, and
 * why its pane says "browsers use Tailscale, the mobile app uses same-network". This module is
 * the other half of that sentence: RN fetch has no secure-context gate and no CORS, and nothing
 * in this seam or the manager touches `navigator.locks`, `isSecureContext` or bare
 * `crypto.randomUUID` (the census in `pairing.test.ts` pins that).
 *
 * What was NOT true, and read as true here for the whole life of this file, is the rest of that
 * sentence: *"a plain `http://192.168…` desktop-host door pairs and drains exactly like an https
 * one."* It does not, and it never did in a build anybody could install. A release build permits
 * no cleartext (`targetSdk` past 28; iOS App Transport Security is the same refusal by another
 * name), so the request died with `UnknownServiceException` before opening a socket. Every
 * exercise of this path was a DEBUG build, whose manifest carries `usesCleartextTraffic`.
 *
 * The door serves TLS now, with a key of its own that no authority vouches for, and
 * {@link admitOrigin} is where this module refuses everything that would paper over that:
 * cleartext to a network address, and an unverifiable address with no pin.
 *
 * ── AND WHERE THE MAIL API IS, WHICH IS NOT ALWAYS THE ORIGIN ───────────────────────────────
 *
 * Every door this app could reach before the self-hosted one served its API at the root of the
 * address the pairing named, so "the origin" and "the base" were one value and nothing had to say
 * which. A one-origin self-host stack breaks that: its proxy routes `/hello`, `/pair/*` and
 * `/auth/*` at the bare path and the `/sync` family only under `/api`. The ceremony below
 * therefore MEASURES the base before it spends the token ({@link resolveApiBase}) and stores it on
 * the profile, and `net/server-base.ts` carries the measurements and the reasoning. Without it a
 * self-host pairing succeeded and mirrored nothing, for ever.
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
import { originNeedsPin, type OhmailEngine, type SqlMirrorStore } from "@ohmail/client-engine";
import {
  bootEngine,
  forgetMirror,
  mirrorOwnerKey,
  normalizeOrigin,
  type IdentityVerdict,
  type MobileEngineDeps,
} from "../engine/boot";
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
 * THE ADDRESS THE MANUAL SCREEN OPENS ON — held in this process, never in a URL.
 *
 * `/connect` used to take the picker's negotiated address as a ROUTE PARAMETER, and this app
 * registers the `ohmail` scheme as a BROWSABLE deep link — so any web page could open
 * `ohmail://connect?origin=<anything>` and choose the server address that screen would then send
 * a pairing token to. That is not a cosmetic prefill, because THE TOKEN IS THE CREDENTIAL:
 * `POST /pair/redeem` is `public + anonymous` and hands a bearer pair to whoever presents the raw
 * token (`packages/api/src/routes/pair.ts:162-164` — its own docblock says so), inside a
 * five-minute default TTL (`packages/services/src/pairing.ts:107`). Combined with the screen's
 * own supported "type the token on its own" path, a prefilled hostile address is a way to have
 * somebody hand their live grant to a stranger who then redeems it at the real server first.
 *
 * A module-level value cannot be reached from outside this process, so the address the manual
 * screen opens on is now necessarily one THIS APP negotiated in this launch (the picker only
 * stashes an origin `/hello` answered for). The whole-link paste path is unchanged and still
 * wins over the field, because a link carries its own origin.
 *
 * READ rather than consumed, deliberately: leaving the manual screen and coming back must show
 * the same address. A stale value is harmless — it can only ever be an app-negotiated origin.
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
 * Ask the server whose session this is — the session read first, the server's own rows where
 * that route is not mounted (see the header). `null` = this door could name no account.
 *
 * TWO ADDRESSES, and they are the same string on two of the three doors. `/auth/session` is
 * routed at the bare ORIGIN everywhere (the self-host Caddyfile names `/auth/*` explicitly), and
 * the row reads are `/sync` family — which a one-origin self-host stack serves ONLY under `/api`.
 * This read is the one place the fallback path is exercised on the door that needs the prefix, so
 * getting it wrong here would leave the pairing naming no account and refusing itself out loud
 * after the token was already burned. See `net/server-base.ts`.
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
  bearer: BearerManagerRN;
  engine: OhmailEngine;
  store: SqlMirrorStore;
  ownerKey: string;
  /**
   * The deferred bearer/account judgment ({@link IdentityVerdict}) — the boot no longer waits
   * on the wire (boot-from-local, `engine/boot.ts`), so the connection layer starts this AFTER
   * adoption, once the dead signal is subscribed, and tears the session down on `mismatch`.
   */
  verifyIdentity: () => Promise<IdentityVerdict>;
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
 * MAY THIS PHONE TALK TO THIS ORIGIN AT ALL — and if so, on what terms?
 *
 * Called before the FIRST request to an origin, in both places a session begins
 * ({@link pairWithServer} and {@link buildSession}), because the pin has to be installed before
 * `/hello` and not merely before the redeem.
 *
 * Three refusals, and every one of them is a thing the platform would otherwise refuse
 * obscurely or — worse — a thing nothing would refuse at all:
 *
 *  1. **Cleartext to a network address.** The OS kills this with
 *     `UnknownServiceException: CLEARTEXT communication to <addr> not permitted by network
 *     security policy`, which reads to a person as "the server is down". Refusing it here says
 *     what actually happened and what to do. Loopback is exempt: a request from this process to
 *     this process is not a network hop, and it is where the test suite's servers live.
 *  2. **An address no certificate can be issued for, with no pin.** An IP literal cannot be
 *     verified by any trust store, so a TLS connection to one is either pinned or unverified.
 *     Unverified is worth nothing, so the only honest answer to "no pin" is no pairing.
 *  3. **A pin this build cannot install.** `canPin()` is false where the native half is absent —
 *     today, that is iOS. Falling through would connect unpinned, which is precisely the
 *     property the pin exists to provide; so it refuses, and says which platform half is
 *     missing rather than blaming the network.
 *
 * Note the fourth case, which is a PASS: a DNS-named https origin with no pin — the hosted
 * service, and a self-host box behind a real certificate. Those are verified by the platform's
 * own trust store exactly as any website is, and a pin there would add a way for the pairing to
 * break on certificate renewal while adding nothing.
 */
export type Admitted =
  /**
   * `enforcedPin` is the key the TLS stack is now ENFORCING for this origin, or `null` where none
   * is needed because the platform's own trust store verifies it.
   *
   * IT IS NOT "the pin that was in the link", and that distinction is the whole reason this type
   * exists. A link carrying a fingerprint for a DNS-NAMED origin installs nothing — `originNeedsPin`
   * is false there, correctly — and the confirmation screen was rendering that unenforced value
   * under "Its key" beside the sentence "the same characters as under Settings → Devices there".
   * An attacker with a real certificate for their own name and the VICTIM's fingerprint in the
   * fragment got a screen that told the person to compare, and the comparison MATCHED. The screen
   * built to catch that was assuring them of it. Only an enforced key may be shown, so only an
   * enforced key leaves here.
   */
  | { ok: true; enforcedPin: string | null }
  | { ok: false; reason: Refusal };

export function admitOrigin(
  origin: string,
  pin: string | null,
  /**
   * The pin this phone ALREADY enforces for this origin, when it has one — read from the stored
   * profile by the caller so this function stays pure.
   *
   * A DIFFERENT pin for an origin already paired under another key is refused rather than
   * installed. `installPin` REPLACES the registry's entry for a (host, port), so without this a
   * probe nobody confirmed rewrote the trust of a LIVE pairing: an attacker answering that address
   * on the network offers a link for it carrying their key, the person probes and backs out, and
   * the next refresh hands the existing bearer to the attacker's machine over a socket the phone
   * now trusts. A key change is a deliberate re-pair — forget and pair again — and never a side
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
   * ── AN ORIGIN THAT NEEDS NO PIN ENFORCES NONE, AND THE TWO CASES DIVERGE ────────────────────
   *
   * Either way the admission carries NO key, because nothing was enforced and only an enforced
   * key may be drawn. What differs is whether the code itself is refused, and the split is the one
   * `originNeedsPin` already argues:
   *
   *  · **A DNS NAME is refused.** The desktop composes a key into a code only for its
   *    same-network address, so a pinned code naming a host is either a mistake or the attack:
   *    a real certificate for the attacker's own name plus the VICTIM's fingerprint in the
   *    fragment. Admitting it silently would leave a pairing that works and a person who believes
   *    they compared a key.
   *  · **LOOPBACK is admitted, with the pin dropped.** That is an exemption rather than an
   *    oversight — no network path exists to attack, which is the same reason `originNeedsPin`
   *    exempts it, and it is where this suite's own servers live. The value is discarded, so the
   *    confirmation shows its no-key sentence and nothing unchecked reaches a screen.
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
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ADMISSION — what a probe MEASURED about a door, and the only way to reach a redeem
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A pairing is two acts with a PERSON between them: find out what is at this address (no
 * credential spent, nothing stored), show them what was found, and only then spend the code.
 * Before this type existed there was one act — {@link pairWithServer} took an origin and a token
 * and redeemed on the spot — which is why a scanned QR paired a phone with whatever answered.
 *
 * A QR is a string nobody can read. The desktop's Devices pane has said, in every shipped
 * release since the same-network door landed, *"a device pairing over your network shows these
 * characters before it pairs. If it shows different ones, something else is answering for this
 * computer."* The phone showed nothing and pressed on. So the sentence was false, and the check
 * it invites — the one thing standing between a scan and trusting a stranger's key for the life
 * of the pairing — was not offered to anybody.
 *
 * WHY IT IS A TYPE AND NOT A SCREEN'S DISCIPLINE. A confirmation any new call site can forget is
 * not a gate. {@link pairWithServer} no longer accepts an origin at all: it accepts one of these,
 * and the only function that makes one is {@link probePairing}. The unconfirmed pairing is not
 * refused — it is unrepresentable. A census over this app's own sources closes the other half by
 * naming the one component allowed to redeem, so a screen that probed and then redeemed without
 * showing anybody the answer is a failing build rather than a review note.
 *
 * Every field is MEASURED, never taken from the link, with one exception that is stated because
 * it matters: `origin` and `pin` ARE the link's, because they are what the phone will connect to
 * and the key it will accept — the subject of the question, not the answer. `flavor` is the
 * door's own word about itself, read over the pinned connection. A "display name" carried in the
 * QR was rejected for this reason: it would let the attacker's code name the attacker's server
 * "MacBook Pro" on the very screen built to catch it.
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
 * ASK AN ADDRESS WHAT IT IS, SPENDING NOTHING.
 *
 * Steps 0, 1 and 1b of the old one-shot ceremony, unchanged and in the same order — the transport
 * gate, `/hello`, and where the mail API answers. Every one is credential-free, which is what
 * lets them run before the person has decided anything and what makes a refusal here cost a
 * sentence instead of a spent code.
 *
 * The TOKEN IS NOT A PARAMETER. It stays with whoever scanned it until the confirmation is
 * pressed, so nothing on this path can log it, send it or hold it.
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

  // 1b — WHERE IS THIS SERVER'S MAIL API? BEFORE THE BURN, and that placing is the whole point.
  //
  // A one-origin self-host stack serves `/hello`, `/pair/*` and `/auth/*` at its root and the
  // `/sync` family only under `/api`. Every request this ceremony makes up to here answers at the
  // root, so the pairing SUCCEEDED against such a stack and then mirrored nothing, for ever, with
  // an HTML 404 as the only clue — the defect `net/server-base.ts` documents and closes. Measured
  // here rather than derived from the door or the flavor, for the reason stated there: a QR
  // carries an origin and no door.
  //
  // Placed before the redeem so a server whose API cannot be found costs a sentence and not a
  // spent code. Both probes are credential-free, which is what lets them run this early.
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

  // 3b — AN OWED FORGET FOR THIS MIRROR IS SETTLED BEFORE THE PAIRING IS ADOPTED.
  //
  // A forget whose deletion failed leaves `{oldId, owner}` in the durable queue, and a re-pair
  // of the SAME (origin, account) resolves to that same owner — and, because `add()` re-pairs in
  // place, often the same profile id. Adopting it would boot the surviving mirror, let the reader
  // queue work into it, and then have the next launch's drain delete the database the person had
  // just re-authorized: a debt written against the OLD pairing collected against the NEW one.
  //
  // So the debt is paid here, on the mail that is genuinely owed a deletion, before anything is
  // stored or booted. The mirror is deleted and read back; the pairing starts from empty, which
  // is what a re-pair after a forget means. If the deletion still cannot land the pairing is
  // REFUSED — adopting a mirror this app owes a deletion for is the one outcome that cannot be
  // made honest, and the token is already spent so the sentence says what to do next.
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
   * A CLEARED TOKEN IS NOT A COMPLETED REVOCATION, and this answered `true` for it.
   *
   * The token is null because the server REFUSED the family — a reuse judgment, a device revoke.
   * That kills the sessions and nothing else: the push row is stamped with the device and is
   * pruned only by `AuthService.logout` or a Devices-pane revoke, neither of which ran. So the
   * registration stays live on a shared distributor endpoint the phone is still answering, and
   * this profile no longer holds anything that could take it down. Saying "told" here reported a
   * complete forget over exactly that. `false` shows the Devices-list remedy, which is the only
   * one left.
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
 * FORGET A PAIRING — the whole ceremony, at the seam rather than in the React provider.
 *
 * ── WHY THIS IS NOT THREE LINES IN A CALLBACK ───────────────────────────────────────────────
 *
 * "Forget this server" spans THREE stores — the keystore (the credential), a SQLite database
 * (the mail), and the server (the session and its wake registration) — and it used to touch
 * one of them. `env.profiles.remove` plus a best-effort logout; the mirror's handle was closed
 * and the file left on disk holding every header in the 90-day window and every body the reader
 * had opened. The app had NO deletion path at all, so the only way to get that mail off the
 * phone was to uninstall it.
 *
 * A take-back is a mutation like any other. It must be performed at every place the thing
 * exists, VERIFIED there, and honest when it cannot be — which is why this is a function with
 * an outcome type and not a callback that resolves to `void`.
 *
 * ── THE ORDER IS FORCED, AND THE FIRST STEP IS THE DURABLE INTENT ───────────────────────────
 *
 *  1. **Mark the wipe owed.** The mirror is named by `(origin, account)` — exactly what the
 *     forgotten profile row stops holding. A kill between the removal and the deletion would
 *     otherwise strand the mail under a name nothing on the device could still derive. Written
 *     first, cleared last, drained at every launch ({@link drainPendingWipes}).
 *  2. **Wait for the store handle to close.** Deleting a database underneath a live sqlite
 *     handle is the kind of thing that works on one platform and not another; the caller passes
 *     the close it already scheduled.
 *  3. **Remove the credential**, and read the keystore back. This is the residue that can still
 *     OPEN the mailbox, so its refusal is the loud one.
 *  4. **Revoke server-side, AWAITED.** This is also what takes the phone's WAKE REGISTRATION
 *     down: the hosted `logout` prunes `push_subscriptions` for the session's device, so a
 *     forgotten server stops ringing a phone that can no longer open the account. Its verdict
 *     shapes the result — see the note at the call for why it is no longer fire-and-forget, and
 *     why a durable retry queue was rejected.
 *  5. **Delete the mail and read it back** ({@link forgetMirror}).
 */
export async function forgetProfile(
  env: PairingEnv,
  profileId: string,
  opts: { closed?: Promise<void>; revoke?: (() => Promise<boolean>) | null } = {},
): Promise<ForgetOutcome> {
  const row = (await env.profiles.list()).find((p) => p.id === profileId) ?? null;
  /**
   * ── A SECOND FORGET OF A ROW THE FIRST ALREADY REMOVED IS NOT AUTOMATICALLY DONE ──────────
   *
   * Two taps before the row re-renders both reach here through the gate. The first writes the
   * debt, removes the credential and — if the mirror deletion failed — returns `partial` with
   * the mail still on the phone. The second then found no row, derived no owner key, and
   * returned `forgotten`: an unearned success that immediately replaced the first tap's honest
   * warning, and on the last pairing sent the screen to Welcome over a mirror that was still
   * there. So a missing row is not the end of the question — the durable queue is asked whether
   * this profile is still owed a forget, and if it is, that debt is what this call finishes.
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

  // ── THE SERVER HALF IS AWAITED, AND ITS ANSWER SHAPES THE RESULT ─────────────────────────
  //
  // This was fire-and-forget on the reasoning that an unreachable server must not hold a local
  // forget open. That reasoning is sound about BLOCKING and was wrong about REPORTING: the
  // credential this call is destroying is the only thing that could ever retry the logout, and
  // the logout is what revokes the session AND, on the hosted tier, takes this device's wake
  // registration down. A forget reported over a logout that never landed leaves both alive with
  // nothing left to retry them — the take-back class, at the one seam where recovery is
  // genuinely impossible afterwards.
  //
  // A DURABLE REVOCATION DEBT WAS CONSIDERED AND REJECTED, because it would have to carry the
  // refresh token: retrying a logout needs the credential, so the queue would be a second
  // durable home for the exact secret the forget exists to remove, kept for as long as the
  // retries take. That is a worse trade than a sentence naming the remedy — and the remedy
  // (revoke the device from the server's Devices list) needs neither this phone nor its token.
  const told = opts.revoke ? await opts.revoke().catch(() => false)
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
     * ── AND SO DOES THE WAKE REGISTRATION, which is this profile's own now ──────────────────
     *
     * Step 4's `logout` prunes the SERVER's `push_subscriptions` row. The DISTRIBUTOR end is the
     * phone's and no server can reach it, and it became per-pairing in this slice — so forgetting
     * one of two pairings left an instance registered for an account this phone can no longer
     * open, for ever. `wake.tsx` sweeps only when the LAST pairing goes (the distributor CHOICE is
     * app-wide), and `forgetWake` is reached only by turning wakes off explicitly. Neither is this
     * path, which is the one a person actually takes.
     *
     * Best-effort for the pin's reason: an endpoint nothing POSTs to is not a residue that opens
     * anything, and a forget must not fail in somebody's face over it.
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
 * Finish the forgets that did not finish — run once at launch, BEFORE any profile is read.
 *
 * ── THE CREDENTIAL GOES FIRST HERE TOO, AND THAT ORDER IS THE WHOLE POINT ───────────────────
 *
 * An owed entry naming a profile means the person pressed Forget and the process died before
 * the keystore row went. Deleting only the mirror in that state is worse than doing nothing:
 * the profile is still there and still ACTIVE, so the launch that follows reconnects it and
 * drains the entire mailbox back onto the phone — a forget interrupted at its documented crash
 * point coming back as a paired server with the mail in it. So the row is removed first, and
 * only then is the mirror deleted and read back.
 *
 * A refusal KEEPS the debt: the entry stays in the index and the next launch tries again. That
 * is the whole reason the intent is durable, so swallowing the failure here is the design and
 * not a shrug. Answers the mirror keys whose mail is still on the device, for the caller's log.
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
 * PAY THE OWED WAKE-ROW DELETIONS — run at launch, beside {@link drainPendingWipes}.
 *
 * A registration is a row on somebody's server, and taking it down is a request that can be
 * refused. The two paths that hit that — a profile switch, and a registration superseded
 * mid-flight — used to fire the delete and discard both the id and its verdict, so a refusal
 * left a row nothing could ever name again. It kept waking a phone for an account it no longer
 * syncs, and because the distributor endpoint is SHARED and still live, the server never got
 * the 404/410 it prunes on.
 *
 * Ridden through a manager on the profile's OWN vault — not a throwaway one, unlike
 * {@link revokeProfile}, and the difference is load-bearing (see the vault's own note): a
 * stored profile holds only a refresh token, so the first attempt 401s and the manager's one
 * recovery spends it into an access token and replays, and the rotation that comes back has to
 * be kept, because this launch is about to boot that same profile. A profile that is gone or
 * whose credential was refused can never pay its debt, so its entry is DROPPED rather than
 * retried for ever — the row will lapse with the pairing it belonged to.
 *
 * Answers the subscription ids still owed, for the caller's log. Never throws.
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
       * ── THE PROFILE'S REAL VAULT, AND THE THROWAWAY ONE HERE WAS A PAIRING-KILLER ─────────
       *
       * `revokeProfile` uses a throwaway vault correctly: the profile it spends is being
       * forgotten, so nothing should persist into it. This drain is the opposite case — the
       * profile it pays a debt for is about to be BOOTED, moments later, by the same launch.
       * A cold manager holds no access token, so the DELETE 401s, the recovery spends the
       * stored refresh token, and the server rotates it. Discarding the replacement leaves the
       * CONSUMED token in the keystore, and presenting a consumed token is the reuse signal
       * that revokes the whole family: paying an ancillary "stop waking me" debt would have
       * ended a perfectly good pairing and sent the reader back to the QR code.
       */
      vault: vaultFor(env.profiles, profile.id),
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
    });
    const dropped = await dropWakeRow(
      { profile, bearer } as unknown as ConnectedSession,
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
   * ── A PROFILE THE PERSON ASKED TO FORGET IS NOT BOOTABLE ──────────────────────────────────
   *
   * A forget whose CREDENTIAL removal was refused leaves the row in place and the debt in the
   * queue — correctly, because the row is the only thing that still names it and the launch
   * retries. What must not follow is the launch then reading that row as the active profile and
   * connecting it: the retry mechanism would be a resurrection path, and the person would be
   * looking at the mailbox they pressed Forget on.
   *
   * Here rather than at the call sites, for this file's own stated reason: this is the ONE place
   * every session is built, so launch, switch and re-pair inherit it and a new caller cannot
   * forget. A re-pair is not caught by it, because `pairWithServer` settles the owed forget
   * before it ever gets here.
   */
  if (await env.profiles.isOwedForget(profile.id)) {
    return {
      kind: "refused",
      reason: refuse("forgetStillPending"),
    };
  }
  /**
   * ── THE PIN IS RE-INSTALLED ON EVERY LAUNCH, HERE, BEFORE ANY WIRE TOUCH ──────────────────
   *
   * The native registry is process-local and empty at launch, so a cold start of a phone paired
   * with a desktop host holds no pin until this line runs. `buildSession` is the ONE place every
   * session is built (launch, profile switch, re-pair), which is the same reason the
   * owed-forget refusal below lives here rather than at the call sites: a new caller cannot
   * forget to do it.
   *
   * A refusal is a refusal to BOOT, never a boot without the pin: the alternative is a phone
   * that, after one restart, accepts any key on the local network for the mailbox it holds.
   */
  /* The stored pin is BOTH the pin to install and the known one, so a launch can never be read
     as a key change: a profile's own key is what it is paired under. */
  const admitted = admitOrigin(profile.origin, profile.pin, profile.pin);
  if (!admitted.ok) return { kind: "refused", reason: admitted.reason };

  /**
   * ── THE ONE POPULATION AN UPGRADE CANNOT FIX BY ITSELF, REPAIRED HERE ─────────────────────────
   *
   * A self-hosted pairing made by a build that predates the measured base is stored with no base at
   * all, which reads as the origin — and the origin is exactly what never worked: every drain
   * fetched an HTML 404 from the web container. Review named the consequence of leaving it: those
   * profiles stay broken FOR EVER, because nothing re-probes, so the fix ships and the people it
   * was written for see no change until somebody tells them to re-pair.
   *
   * ── AND IT DOES NOT BREAK BOOT-FROM-LOCAL, BECAUSE OF WHO IT APPLIES TO ──────────────────────
   *
   * `bootEngine`'s contract is that the boot touches no wire, so the app paints its cached mirror
   * immediately. That is why this is NOT a blanket re-probe: it is gated on `flavor === "selfhost"`
   * AND `apiBase === null`, which is precisely the set of profiles that have never mirrored a
   * single message. There is no cached mirror to paint quickly for them — the rule's whole benefit
   * is nil for exactly this set, and its cost is one or two credential-free requests, once, after
   * which the base is stored and this never runs again.
   *
   * Every other profile — managed, desktop-host, local, and any selfhost row paired since the
   * measurement — takes the same wire-free path it always did.
   *
   * A FAILURE HERE IS NOT FATAL. If the probe cannot find the API the profile boots against the
   * origin exactly as it did before, which is no worse than the state it is already in, and the
   * drain's own sync error says what happened. Refusing the boot would turn a broken mirror into
   * an app that will not open at all.
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
      engine: boot.engine,
      store: boot.store,
      ownerKey: mirrorOwnerKey(profile.origin, profile.accountId),
      verifyIdentity: boot.verifyIdentity,
    },
  };
}
