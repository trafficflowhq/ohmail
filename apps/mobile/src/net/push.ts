import type { ConnectedSession } from "./pairing.js";

/**
 * New-mail wake — the registration half. The phone's distributor app (the user's choice)
 * mints an endpoint URL, the app hands it to the server it is paired with, and the server
 * POSTs a content-free "something changed" — no Google, no Apple, no relay of ours. This file
 * is the server side; the connector is `unified-push.ts`, reached through the
 * {@link UnifiedPushDistributor} port, so tests hand over a double. The VAPID key is fetched
 * first (`GET /push/vapid-key`) — a wrong-key registration fails silently later. The endpoint
 * goes to the active profile's server only (`session.fetch`, bound to one origin); a
 * desktop-host profile is refused locally with a named reason ({@link registerWake}).
 */

/** The registration a distributor produced. `keys` is absent on a distributor that has none. */
export interface WakeRegistration {
  /** The URL the server POSTs the wake to. Opaque to us; the distributor chose every byte. */
  endpoint: string;
  /**
   * The Web Push key pair a UnifiedPush 3.x connector hands back (`p256dh` = the device's
   * public key, `auth` = its authentication secret). Sent when present, omitted otherwise, and
   * this file reads neither: they are the device's key material and their only consumer is the
   * server's sender, which seals the wake so only this phone can open it. Absent is not a
   * broken registration — a distributor without the encrypted profile hands back a URL alone,
   * and the server's plaintext arm serves it.
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
   * Ask the distributor for an endpoint of `instance`'s own, registering with
   * `vapidPublicKey`. The key is a parameter, not implementation state: it belongs to
   * whichever profile is active, and a distributor object constructed with one key could
   * outlive a switch. The instance makes a registration belong to one pairing — with no
   * instance the connector minted one endpoint for the whole process, so a forget took the
   * surviving pairings' wakes down and a delivered wake named no pairing. One instance per
   * profile: `ServerProfile.id`, locally minted, deliberately not the account id (this value
   * goes to a third-party app). `null` = declined, timed out, or no distributor.
   */
  register(vapidPublicKey: string, instance: string): Promise<WakeRegistration | null>;
  /**
   * Drop `instance`'s registration and nothing else. Best-effort; a failure is not an error to
   * show. REQUIRED, with no default: an unregister that named nothing is how one pairing's forget
   * silently turned another pairing's wakes off.
   */
  unregister(instance: string): Promise<void>;
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
  unregister: async () => { /* nothing was ever registered, for any instance */ },
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
 * Ask the active profile's server for its VAPID public key. `null` covers three cases on
 * purpose — no keypair configured, the route not mounted, the request failed — because the
 * app's next move is the same in all three: do not register, and say so. The key is not
 * cached across calls: it is one small request, and a stale key is exactly the failure this
 * path exists to avoid — an operator who rotates their keypair must have the next
 * registration pick up the new one.
 */
export async function serverVapidKey(session: ConnectedSession): Promise<string | null> {
  try {
    const res = await session.fetch(`${session.profile.origin}/push/vapid-key`, {
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
 * Register this device's wake endpoint with the active profile's server. Four steps, in
 * order: (1) local questions first — hosted profile, distributor chosen — so every refusal
 * decidable without a round trip names the actual reason; (2) the server's VAPID key, before
 * the distributor is asked for anything — a registration against the wrong key (or none)
 * looks exactly like a working one from here and only fails later, silently, on the phone,
 * so its absence is a refusal; (3) the distributor, with that key; (4) the server, with the
 * endpoint the distributor produced.
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
    // THE INSTANCE IS THIS PROFILE'S, so the endpoint minted here belongs to this pairing and to
    // no other. See the port's docblock for the three failures the shared endpoint caused.
    reg = await distributor.register(vapidKey, session.profile.id);
  } catch {
    return { k: "off", reason: "distributor_refused" };
  }
  if (!reg || reg.endpoint === "") return { k: "off", reason: "distributor_refused" };

  /**
   * Every outcome of this function is a `WakeState`, the transport failing included. The key
   * fetch and the distributor call were already wrapped; this POST was not, so a phone that
   * lost signal between registering with its distributor and telling the server got a
   * rejected promise out of `registerWake` — an unhandled rejection under `void attempt(…)`,
   * with the Settings pane still saying "on". A `catch` around the request rather than the
   * whole function, so a bug in the branching below still surfaces.
   */
  let res: Response;
  try {
    res = await session.fetch(`${session.profile.origin}/push/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transport: "unifiedpush",
        endpoint: reg.endpoint,
        ...(reg.keys ? { p256dh: reg.keys.p256dh, auth: reg.keys.auth } : {}),
      }),
    });
  } catch {
    return { k: "off", reason: "server_unavailable" };
  }

  if (res.status === 201 || res.status === 200) {
    /**
     * A 2xx whose body will not parse is the server answering something this build does not
     * understand — a proxy's HTML error page under a 200 is the ordinary way that happens. It is
     * `server_unavailable` and not `server_answer_unrecognised`, because the latter is for a
     * well-formed answer with no usable `id`: one means "we could not talk to it", the other means
     * "we talked to it and it said something else", and the copy for the two differs.
     */
    /**
     * PARSED AS `unknown`, AND THE SHAPE CHECKED BEFORE ANYTHING IS READ OFF IT.
     *
     * The obvious version — `(await res.json()) as { id?: unknown }` — is a lie the compiler
     * believes: `null` is valid JSON, so a 200 whose body is literally `null` resolves the promise
     * and then `body.id` throws a TypeError. The `catch` above covers the PARSE, not the property
     * access, so this function rejected after all — the exact defect the wrapping was added to fix,
     * one line further down. A cast is not a check.
     */
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { k: "off", reason: "server_unavailable" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { k: "off", reason: "server_answer_unrecognised" };
    }
    const id = (parsed as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return { k: "on", id };
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
 * Did the server row really go? `ok: false` means it is still there and still causes wakes.
 *
 * A verdict and not `void`, because "the registration was removed" is a claim the Settings pane
 * makes to a person: this helper answered `void` for a 401, a 500 and a dead network alike, and
 * the pane said the registration was gone over a row the server had kept.
 */
export type WakeDrop = { ok: true } | { ok: false; reason: string };

/**
 * Take one server row down, and leave the distributor alone — split out of {@link forgetWake}
 * for the case that has no other answer: switching profiles. Registrations are per profile
 * now, so A's endpoint could be dropped without touching B's; this is kept because the row is
 * a separate fact from the endpoint and the row is what causes traffic. A switch that only
 * unregistered A's instance would leave A's server dialling a dead endpoint until enough
 * 404/410s prune it. The invariant: no server holds a row for a pairing this phone is not
 * using, and this call discharges it. Never throws — a take-back must not fail in the user's
 * face over an unreachable server, and a quiet endpoint's row is pruned server-side.
 */
export async function dropWakeRow(session: ConnectedSession, id: string | null): Promise<WakeDrop> {
  if (id === null) return { ok: true };
  let res: Response;
  try {
    res = await session.fetch(`${session.profile.origin}/push/subscriptions/${id}`, {
      method: "DELETE",
    });
  } catch {
    return { ok: false, reason: "server_unavailable" };
  }
  // 404 IS SUCCESS, and it is the only status besides 2xx that is: the row this call exists to
  // remove is absent, which is the whole thing being asked for. Everything else — a 401 on a
  // dead credential, a 500, a proxy's HTML error page — leaves the row where it was, and this
  // used to report all of them as a removal because it read no status at all.
  if (res.status === 404 || (res.status >= 200 && res.status < 300)) return { ok: true };
  return { ok: false, reason: res.status === 401 || res.status === 403 ? "refused" : "server_unavailable" };
}

/** What {@link dropWakeRowOrOwe} needs from the profile store — write the debt, and clear it. */
export interface WakeDebtStore {
  markPendingWakeDrop(profileId: string, subscriptionId: string): Promise<void>;
  clearPendingWakeDrop(subscriptionId: string): Promise<void>;
}

/**
 * Take a row down, and if the server refuses, write the debt down. Both callers — a profile
 * switch and a registration superseded mid-flight — fire it and walk away, which is exactly
 * what lost things before: the subscription id was dropped at dispatch and the verdict never
 * read, so a 401, 500 or lost network left a row nothing could name again — and the shared,
 * still-answering distributor endpoint means the server never gets the 404/410 it prunes on.
 * The debt is durable and paid at the next launch (`pairing.ts#drainPendingWakeDrops`). A full
 * queue refuses, and that refusal is swallowed here deliberately: there is no surface in a
 * background switch to show it on. Never throws.
 */
export async function dropWakeRowOrOwe(
  session: ConnectedSession, id: string, profiles: WakeDebtStore,
): Promise<WakeDrop> {
  /**
   * The debt is written before the attempt, not after. Recording it afterwards made the
   * durability conditional on the very thing that was failing: the callers discard the
   * in-memory id at dispatch, so a kill between the DELETE going out and the debt landing left
   * nothing holding the only id that can remove the row. Persist the intent first, execute
   * second. A debt that cannot be recorded is refused rather than attempted — a delete that
   * might fail unretryably must not be dressed as completed. Cleared only on a confirmed 2xx
   * or 404.
   */
  try {
    await profiles.markPendingWakeDrop(session.profile.id, id);
  } catch (err) {
    return { ok: false, reason: `could_not_record_debt: ${String(err)}` };
  }
  const dropped = await dropWakeRow(session, id);
  if (dropped.ok) await profiles.clearPendingWakeDrop(id).catch(() => undefined);
  return dropped;
}

/**
 * Take the registration down: server first, then the distributor — the opposite of the
 * intuitive order. The server row is what causes wakes, so it goes first; if the distributor
 * call fails afterwards the worst case is a distributor holding an endpoint nobody POSTs to.
 * The other order leaves the row live for an endpoint that no longer exists, dialled until
 * the distributor answers 410. Neither half throws: a forget is deliberate and must not fail
 * in the user's face; local state clears either way, but the server's verdict is returned so
 * the pane can stop claiming a removal it did not get.
 */
export async function forgetWake(
  session: ConnectedSession, distributor: UnifiedPushDistributor, id: string | null,
  /**
   * REQUIRED, so a caller cannot take a row down without the debt behind it. Turning wakes off
   * explicitly went through this function and NOT through the debt queue, so a refused delete
   * was remembered only by the live provider — one restart and the id was gone, while the pane
   * said "nothing wakes this app between visits" over a row the server was still dialling.
   */
  profiles: WakeDebtStore,
): Promise<WakeDrop> {
  const dropped = id === null ? { ok: true } as WakeDrop : await dropWakeRowOrOwe(session, id, profiles);
  try {
    // THIS PROFILE'S INSTANCE, and that is the whole of what changed here: an unregister with no
    // instance dropped the app's single shared registration, so forgetting one server turned
    // every other pairing's wakes off on the way past.
    await distributor.unregister(session.profile.id);
  } catch {
    /* best-effort by contract: the endpoint is this phone's own, and a server that keeps
       POSTing to an unregistered one prunes on the first 404/410 it gets back */
  }
  // The DISTRIBUTOR half is genuinely best-effort; the SERVER ROW is not, and its verdict is
  // what the pane renders. A forget still clears the local state either way — a take-back the
  // person asked for must not fail in their face — but it no longer CLAIMS the row is gone.
  return dropped;
}
