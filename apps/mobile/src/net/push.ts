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
 * It is the SERVER SIDE of that handshake: given an endpoint a distributor produced, register it
 * with the ACTIVE profile's server, and take it down again on forget. That half is finished and
 * tested.
 *
 * It is NOT a distributor connector, and there is no connector in the shipped dependency graph
 * yet. {@link UnifiedPushDistributor} is the port one plugs into, and {@link NO_DISTRIBUTOR} — no
 * distributor available, nothing to register — is what the app runs on today. That is a real state
 * on a real phone (most Android devices have no distributor installed until the user picks one, and
 * every iPhone is in it permanently), so it is a state the UI has to say out loud rather than a
 * placeholder: Settings shows one plain sentence, and there is no switch to flip. A toggle that
 * cannot do anything is worse than no toggle.
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
   * Sent when present and otherwise omitted, and NOTHING here depends on them. They are forwarded
   * because the server stores them if offered, which is what lets an encrypting sender arrive
   * later without every device having to re-register. The wake this app's servers send today is
   * unencrypted, so a connector that requires the encrypted profile will not render it — that is
   * the open question this slice reports rather than papers over.
   */
  keys?: { p256dh: string; auth: string };
}

/**
 * A UnifiedPush distributor, as this app needs it. The port exists so the app can be honest about
 * having none: `available()` is the single question Settings asks, and the answer today is `false`.
 */
export interface UnifiedPushDistributor {
  /** Is there a distributor on this device we could register with? */
  available(): boolean;
  /** Ask the distributor for an endpoint. `null` means it declined or there is none. */
  register(): Promise<WakeRegistration | null>;
  /** Tell the distributor to forget this app. Best-effort; a failure is not an error to show. */
  unregister(): Promise<void>;
}

/**
 * The shipped distributor: none.
 *
 * Named explicitly rather than left as an `undefined` somebody has to remember to handle. Every
 * caller in this app takes a distributor as an argument and this is the value they get, so the
 * no-distributor path is the one the app actually executes and the one the tests exercise.
 */
export const NO_DISTRIBUTOR: UnifiedPushDistributor = {
  available: () => false,
  register: async () => null,
  unregister: async () => { /* nothing was ever registered */ },
};

/** What the Settings pane needs to know, and the only thing it renders from. */
export type WakeState =
  /** No distributor on the device — the ordinary case, and not an error. */
  | { k: "no_distributor" }
  /** This profile is a desktop host; wake registrations are a hosted-journal thing. */
  | { k: "not_supported_here" }
  /** Registered with the paired server. `id` is what a forget takes down. */
  | { k: "on"; id: string }
  /** A distributor exists but the registration did not land. `reason` is for the sentence. */
  | { k: "off"; reason: string };

/** Flavors that keep `push_subscriptions`. A desktop host does not, and is refused locally. */
const HOSTED_FLAVORS = new Set(["managed", "selfhost", "self-host"]);

/**
 * Register this device's wake endpoint with the active profile's server.
 *
 * The order is deliberate: ask the LOCAL questions first (is this profile even a hosted one, is
 * there a distributor at all) and only then make a request. Every refusal that can be decided
 * without a round trip is decided without one, so the failure a user is shown names the actual
 * reason instead of a status code.
 */
export async function registerWake(
  session: ConnectedSession, distributor: UnifiedPushDistributor,
): Promise<WakeState> {
  if (!HOSTED_FLAVORS.has(session.profile.flavor)) return { k: "not_supported_here" };
  if (!distributor.available()) return { k: "no_distributor" };

  let reg: WakeRegistration | null;
  try {
    reg = await distributor.register();
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
