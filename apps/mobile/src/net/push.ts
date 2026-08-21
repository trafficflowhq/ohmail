import type { ConnectedSession } from "./pairing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  NEW-MAIL WAKE — the registration half, and the honest absence of a distributor
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A UnifiedPush wake works like this and no other way: the phone has a DISTRIBUTOR app installed
 * (ntfy, NextPush, Sunup — the user's choice, not ours), the distributor mints an endpoint URL for
 * this app, the app hands that URL to whichever server it is paired with, and the server POSTs a
 * content-free "something changed" to it. No Google, no Apple, no relay of ours, and no account
 * anywhere except the one the user already has.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────────────────
 *
 * It is the SERVER SIDE of that handshake: fetch the key the device must register with, hand the
 * resulting endpoint to the ACTIVE profile's server, and take it down again on forget.
 *
 * It is NOT the distributor connector. That is `unified-push.ts`, which is the only file that
 * touches the native module, and it arrives here through the {@link UnifiedPushDistributor} port —
 * so every test in this file hands over a double and none of them needs a device.
 * {@link NO_DISTRIBUTOR} remains the answer on a phone with no distributor chosen and on every
 * iPhone, which is a real state rather than a placeholder: Settings says so in one sentence.
 *
 * ── THE SERVER'S VAPID KEY IS PART OF THE HANDSHAKE, AND IT COMES FIRST ───────────────────────
 *
 * A UnifiedPush 3.x connector cannot register without a VAPID public key: it gives the key to the
 * distributor and thereafter renders only wakes signed by the matching private half. The key is
 * per-DEPLOYMENT, so it has to be asked for — `GET /push/vapid-key` on the profile the user paired
 * with. Two consequences that shape this file:
 *
 *  · the fetch happens BEFORE the distributor is asked for anything, because a registration made
 *    with the wrong key is indistinguishable from a working one until a wake silently fails to
 *    render on the phone;
 *  · a server that answers `{ publicKey: null }` has no keypair, and that is a real, supported
 *    configuration rather than an error. It gets its own {@link WakeState} and its own sentence,
 *    because "your server has not set this up" is actionable by the person running the server and
 *    "wake notifications could not be set up" is not.
 *
 * ── THE ENDPOINT GOES TO THE ACTIVE PROFILE'S SERVER. NEVER ANYWHERE ELSE. ────────────────────
 *
 * `session.bearer.fetch` is the only transport used here, and it is bound to ONE origin — the
 * profile the user is currently connected to. That is what makes "the endpoint goes to the server
 * you paired with, managed or self-host" a structural property rather than a promise: this file
 * has no origin of its own to send anything to, and the app's own privacy census forbids it one.
 *
 * A DESKTOP-HOST profile is refused before a request is made (see {@link registerWake}). Push
 * registrations live in the hosted journal, which a desktop install's mail-only database does not
 * have, so a desktop-host server would answer 404 or 501 to a registration it has no table for.
 * Refusing locally with a named reason is the difference between "your desktop cannot do this"
 * and an unexplained failure — and it is why the copy for that arm says foreground sync and
 * pull-to-refresh, which is what actually happens there.
 */

/** The registration a distributor produced. `keys` is absent on a distributor that has none. */
export interface WakeRegistration {
  /** The URL the server POSTs the wake to. Opaque to us; the distributor chose every byte. */
  endpoint: string;
  /**
   * The Web Push key pair a UnifiedPush 3.x connector hands back (`p256dh` = the device's public
   * key, `auth` = its authentication secret).
   *
   * Sent when present and omitted otherwise, and this file reads neither: they are the DEVICE's
   * key material and their only consumer is the server's sender, which seals the wake to them so
   * that only this phone can open it.
   *
   * Absent is not a broken registration — a distributor that does not implement the encrypted
   * profile hands back a URL alone, and the server's plaintext arm serves it. Present is the
   * ordinary case for a UnifiedPush 3.x connector, and it is what makes a wake renderable.
   */
  keys?: { p256dh: string; auth: string };
}

/**
 * A UnifiedPush distributor, as this app needs it.
 *
 * A PORT rather than a direct dependency on the native module, for two reasons that both still
 * hold now that a real connector exists: `available()` has to be answerable on a phone with no
 * distributor and on every iPhone, and every test of the registration flow gets to run without a
 * device. `unified-push.ts` is the real implementation; {@link NO_DISTRIBUTOR} is the honest
 * answer everywhere it cannot load.
 */
export interface UnifiedPushDistributor {
  /** Is there a distributor on this device we could register with — chosen AND installed? */
  available(): boolean;
  /**
   * Ask the distributor for an endpoint, registering with `vapidPublicKey`.
   *
   * The key is a PARAMETER rather than something the implementation holds, and that is the shape
   * that makes "registered against the wrong server's key" hard to write: the key comes from
   * whichever profile is active, the app can hold several profiles, and a distributor object that
   * had been constructed with one key could outlive a switch to another. Passing it per call means
   * the key and the server it is sent to are read in the same breath.
   *
   * `null` means the distributor declined, timed out, or there is none.
   */
  register(vapidPublicKey: string): Promise<WakeRegistration | null>;
  /** Tell the distributor to forget this app. Best-effort; a failure is not an error to show. */
  unregister(): Promise<void>;
}

/**
 * NO distributor: an explicit value rather than an `undefined` somebody has to remember to handle.
 *
 * It is what `unified-push.ts` effectively becomes on iOS, on a build without the native module,
 * and — the common case — on an Android phone where the user has not chosen a distributor yet. So
 * this is not a stub for a missing feature: it is the state a large share of devices are genuinely
 * in, which is why Settings renders a sentence for it and no dead control.
 */
export const NO_DISTRIBUTOR: UnifiedPushDistributor = {
  available: () => false,
  register: async () => null,
  unregister: async () => { /* nothing was ever registered */ },
};

/** What the Settings pane needs to know, and the only thing it renders from. */
export type WakeState =
  /** No distributor chosen or installed — the ordinary case, and not an error. */
  | { k: "no_distributor" }
  /** This profile is a desktop host; wake registrations are a hosted-journal thing. */
  | { k: "not_supported_here" }
  /**
   * The SERVER has no VAPID keypair, so it cannot sign a wake this phone would render.
   *
   * Its own state rather than an `off` reason, because it is the only one whose fix belongs to a
   * different person: whoever runs the server generates a keypair. Telling a self-hoster that is
   * useful; telling them "wake notifications could not be set up" is not.
   */
  | { k: "server_has_no_key" }
  /** Registered with the paired server. `id` is what a forget takes down. */
  | { k: "on"; id: string }
  /** A distributor exists but the registration did not land. `reason` is for the sentence. */
  | { k: "off"; reason: string };

/** Flavors that keep `push_subscriptions`. A desktop host does not, and is refused locally. */
const HOSTED_FLAVORS = new Set(["managed", "selfhost", "self-host"]);

/**
 * Ask the active profile's server for its VAPID public key.
 *
 * `null` covers three cases on purpose — no keypair configured, the route not mounted, the request
 * failed — and they collapse because the app's next move is the same in all three: do not register,
 * and say so. Distinguishing "your server has no key" from "your server did not answer" would put a
 * second sentence on the screen for a difference the user cannot act on differently.
 *
 * The key is NOT cached across calls. It is one small request made when a Settings pane opens or a
 * registration is attempted, and a stale key is exactly the failure this whole path exists to avoid:
 * an operator who rotates their keypair must have the next registration pick up the new one.
 */
export async function serverVapidKey(session: ConnectedSession): Promise<string | null> {
  try {
    const res = await session.bearer.fetch(`${session.profile.origin}/push/vapid-key`, {
      method: "GET",
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { publicKey?: unknown };
    // A trimmed non-empty string or nothing. An empty string would be handed straight to
    // `registerDevice`, which would reject — a null here turns that into a sentence instead.
    if (typeof body.publicKey !== "string") return null;
    const key = body.publicKey.trim();
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

/**
 * Register this device's wake endpoint with the active profile's server.
 *
 * The order is deliberate, and there are now four steps rather than two:
 *
 *  1. LOCAL questions first — is this profile even a hosted one, is a distributor chosen. Every
 *     refusal that can be decided without a round trip is decided without one, so the failure a
 *     user is shown names the actual reason instead of a status code.
 *  2. THE SERVER'S VAPID KEY, before the distributor is asked for anything. A registration made
 *     against the wrong key, or against no key, looks exactly like a working one from here — the
 *     distributor mints an endpoint either way and the server stores it happily — and only fails
 *     later, on the phone, silently. So the key is obtained first and its absence is a refusal.
 *  3. THE DISTRIBUTOR, with that key.
 *  4. THE SERVER, with the endpoint the distributor produced.
 */
export async function registerWake(
  session: ConnectedSession, distributor: UnifiedPushDistributor,
): Promise<WakeState> {
  if (!HOSTED_FLAVORS.has(session.profile.flavor)) return { k: "not_supported_here" };
  if (!distributor.available()) return { k: "no_distributor" };

  /**
   * NO KEY, NO REGISTRATION. Not a soft failure: without a keypair the server cannot sign a wake,
   * the connector will not render one, and registering anyway would produce a row the organizer
   * skips and a Settings pane that says "on" about nothing.
   */
  const vapidKey = await serverVapidKey(session);
  if (vapidKey === null) return { k: "server_has_no_key" };

  let reg: WakeRegistration | null;
  try {
    reg = await distributor.register(vapidKey);
  } catch {
    return { k: "off", reason: "distributor_refused" };
  }
  if (!reg || reg.endpoint === "") return { k: "off", reason: "distributor_refused" };

  const res = await session.bearer.fetch(`${session.profile.origin}/push/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transport: "unifiedpush",
      endpoint: reg.endpoint,
      ...(reg.keys ? { p256dh: reg.keys.p256dh, auth: reg.keys.auth } : {}),
    }),
  });

  if (res.status === 201 || res.status === 200) {
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id === "string") return { k: "on", id: body.id };
    return { k: "off", reason: "server_answer_unrecognised" };
  }
  /**
   * A 400 here is the SERVER'S SSRF gate refusing the endpoint, and it is the one failure worth
   * distinguishing: it means the distributor handed us a URL the server will not dial (a LAN
   * address on a managed host, plaintext http, a name that resolves somewhere private). Nothing
   * the user can do about it from this screen, but "your distributor's address was refused" is a
   * true sentence and "push is off" is not an explanation.
   */
  if (res.status === 400) return { k: "off", reason: "endpoint_refused" };
  if (res.status === 404 || res.status === 501) return { k: "not_supported_here" };
  return { k: "off", reason: "server_unavailable" };
}

/**
 * Take the registration down: server first, then the distributor.
 *
 * That order matters and is the opposite of the intuitive one. The server row is what causes
 * wakes, so it goes first — if the distributor call fails afterwards the worst case is a
 * distributor holding an endpoint nobody POSTs to. Unregistering the distributor first would leave
 * the row live for an endpoint that no longer exists, and the server would keep dialling it until
 * the distributor started answering 410.
 *
 * Neither half throws. A forget is something a person did on purpose; it must not fail in their
 * face because a server is unreachable, and the local state is cleared either way.
 */
export async function forgetWake(
  session: ConnectedSession, distributor: UnifiedPushDistributor, id: string | null,
): Promise<void> {
  if (id !== null) {
    try {
      await session.bearer.fetch(`${session.profile.origin}/push/subscriptions/${id}`, {
        method: "DELETE",
      });
    } catch {
      /* unreachable server: the local forget still happens, and a dead endpoint prunes itself */
    }
  }
  try {
    await distributor.unregister();
  } catch {
    /* best-effort by contract */
  }
}
