/**
 * THE ACCOUNT WALL'S ONE SINK — every authenticated request this phone makes rides the paired
 * session's transport, and every hosted door may answer `402 subscription_required`. Handling it
 * where it lands would mean meeting the refusal one failed read at a time, each screen saying its
 * own thing; the shell subscribes here instead and swaps the whole surface for one screen.
 *
 * THE KEY IS THE CODE, never the `reason`: `reason` is display text the API may reword, and the
 * phone already had one place comparing it (`state/live.ts`'s trash page) that never matched the
 * gate's answer. The lock is raised by a notifier and the `Response` is handed back untouched, so
 * nothing that already handles a refusal changes behaviour.
 *
 * A STANDALONE phone has no plane and no bearer, so it can never raise one — the wrap is composed
 * beside the paired door's manager and nowhere else (`net/pairing.ts`).
 */

/** What the entitlements gate answers, and the one code that means this ACCOUNT, not this request. */
export const ACCESS_REFUSED_STATUS = 402;
export const ACCESS_REFUSED_CODE = "subscription_required";

/**
 * WHERE THIS ACCOUNT STANDS WITH THE SERVICE — the entitlements program's own statement, never a
 * clock this phone runs. Every field is a fact the server holds: a sentence worked out from the
 * device's clock would read differently on a phone whose clock is off, and a sentence about
 * somebody's account is the last place that may happen.
 *
 * A MIRROR of `apps/webapp/app/api-client.ts`'s type of the same name, not an import — this app
 * shares no module with the browser client. `test/account-wall.test.ts` holds the two lists
 * against that file so they cannot drift apart in silence.
 */
export interface AccountLifecycle {
  state: "trialing" | "grace" | "past_due" | "active" | "closed" | "erased";
  /** Why it closed, or `null` — including for a closure the server could not attribute. */
  closedReason: null | "trial_ended" | "canceled" | "unpaid" | "suspended";
  /** While `grace` or `past_due`: when access stops. */
  graceUntil?: string | null;
  /** While `trialing`: when the trial ends. */
  trialEndsAt?: string | null;
  closedAt?: string | null;
  /** When the kept settings are erased; `null` while an operator holds the account. */
  erasureAt?: string | null;
  erasedAt?: string | null;
  formerlyPaid?: boolean;
}

/** The states this build knows. An unknown one drops the whole block — see {@link lifecycleOf}. */
export const LIFECYCLE_STATES = [
  "trialing", "grace", "past_due", "active", "closed", "erased",
] as const;

/** The closure reasons this build has a sentence for. Anything else reads as "not attributed". */
export const CLOSED_REASONS = ["trial_ended", "canceled", "unpaid", "suspended"] as const;

const isoOrNull = (v: unknown): string | null =>
  (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Narrow a lifecycle block, or answer `undefined`.
 *
 * `undefined` is the OLD-SERVER answer and the unknown-state answer alike, and both must land in
 * the same place: the wall says the undated thing it has always said rather than a date somebody
 * would plan around. Rendering a state this build does not know would put a screen on a phone
 * with nothing on it a person can act on, which is worse than the honest older sentence.
 */
export function lifecycleOf(value: unknown): AccountLifecycle | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  if (typeof state !== "string") return undefined;
  if (!(LIFECYCLE_STATES as readonly string[]).includes(state)) return undefined;
  const reason = raw.closedReason;
  return {
    state: state as AccountLifecycle["state"],
    closedReason:
      typeof reason === "string" && (CLOSED_REASONS as readonly string[]).includes(reason)
        ? (reason as AccountLifecycle["closedReason"])
        : null,
    graceUntil: isoOrNull(raw.graceUntil),
    trialEndsAt: isoOrNull(raw.trialEndsAt),
    closedAt: isoOrNull(raw.closedAt),
    erasureAt: isoOrNull(raw.erasureAt),
    erasedAt: isoOrNull(raw.erasedAt),
    formerlyPaid: raw.formerlyPaid === true,
  };
}

/** Why access was refused, and where the person can put it right. The API's words, narrowed. */
export interface AccessRefusedFacts {
  reason: "payment_required" | "suspended";
  manageUrl?: string;
  /**
   * WHAT HAPPENED AND WHEN. Absent from a server that predates the wall, and absent is not
   * "nothing happened": the screen then says the undated thing it has always said.
   */
  lifecycle?: AccountLifecycle;
  /** Where the settings document is served. Absent = no export door here, so none is offered. */
  exportPath?: string;
}

/**
 * The 402's `details`, narrowed — or `null` where this is not a refusal this client may act on.
 *
 * Pure, and the whole judgment: the status, the envelope's CODE and every field. A body that is
 * not JSON, or a 402 carrying another code, answers `null` — a refusal this build cannot read is
 * not one it may put a wall up for.
 */
export function refusalFactsOf(status: number, bodyText: string): AccessRefusedFacts | null {
  if (status !== ACCESS_REFUSED_STATUS) return null;
  let env: { code?: unknown; details?: unknown } | undefined;
  try {
    env = (JSON.parse(bodyText) as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  } catch {
    return null;
  }
  if (env?.code !== ACCESS_REFUSED_CODE) return null;
  const d = (env.details ?? {}) as {
    reason?: unknown; manageUrl?: unknown; lifecycle?: unknown; exportPath?: unknown;
  };
  const url = typeof d.manageUrl === "string" && d.manageUrl.length > 0 ? d.manageUrl : undefined;
  const lifecycle = lifecycleOf(d.lifecycle);
  const exportPath =
    typeof d.exportPath === "string" && d.exportPath.startsWith("/") ? d.exportPath : undefined;
  return {
    /* An unrecognised reason is `payment_required` — the arm whose remedy is a door the person
       can act on, rather than one that reads as our fault. */
    reason: d.reason === "suspended" ? "suspended" : "payment_required",
    ...(url ? { manageUrl: url } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(exportPath ? { exportPath } : {}),
  };
}

/* ── the one slot the shell reads ─────────────────────────────────────────────────────────── */

let locked: AccessRefusedFacts | null = null;
const watchers = new Set<(facts: AccessRefusedFacts | null) => void>();

/** What the wall is rendering, or `null` while the app is the app. */
export function accessLock(): AccessRefusedFacts | null {
  return locked;
}

/** Subscribe to the slot. Returns the unsubscribe; every subscriber is told, unlike the browser's. */
export function onAccessLock(watch: (facts: AccessRefusedFacts | null) => void): () => void {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}

function tell(): void {
  for (const watch of [...watchers]) {
    // A watcher that throws must not stop the others hearing, and must never replace the
    // refusal with its own failure.
    try { watch(locked); } catch { /* the slot is set either way */ }
  }
}

/**
 * RAISE THE WALL — and it does not come down on its own.
 *
 * A LATER 200 CLEARS NOTHING (the browser shell's rule, kept): a refused account's own reads
 * still answer (`/account/access`, the export), and a cached page answering 200 behind the wall
 * would flicker the app back for a person whose account is closed. Signing in again clears it,
 * and nothing else does — {@link clearAccessLock}.
 *
 * The NEWEST facts win while it stands: a wall already up re-renders with a later closure's date
 * rather than keeping the first one it heard.
 */
export function raiseAccessLock(facts: AccessRefusedFacts): void {
  locked = facts;
  tell();
}

/**
 * Take the wall down. The ONE caller is the connection layer, at the moment a session is
 * established — signing in again is the gesture that clears it, on every surface.
 */
export function clearAccessLock(): void {
  if (locked === null) return;
  locked = null;
  tell();
}

/** Tests only: forget the slot AND every watcher, so one case cannot see another's. */
export function resetAccessLockForTests(): void {
  locked = null;
  watchers.clear();
}

/* ── the wrap ─────────────────────────────────────────────────────────────────────────────── */

/** The loose-init fetch shape this app's transports all have (`net/bearer.ts#FetchLike`). */
type FetchLike = (url: string, init?: unknown) => Promise<Response>;

/**
 * Wrap a paired session's transport so a 402 raises the wall once, for the whole app.
 *
 * The body is READ AND REBUILT rather than cloned, and that is React Native's shape rather than a
 * preference: this runtime's `Response` is `whatwg-fetch`'s, whose `body` property does not exist
 * — a copy made from `res.body` arrives EMPTY and every caller downstream reads a truncated
 * answer. A `Response` built from the TEXT is exact on both runtimes. Only a 402 pays for it; every
 * other answer is handed back the very object the transport returned.
 *
 * A read that throws says NOTHING: no wall, and the original response is still returned, because a
 * refusal this client could not read is not one it may act on — and the caller's own handling of
 * the 402 must not be replaced by this module's failure.
 */
export function withAccessLock(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    if (res.status !== ACCESS_REFUSED_STATUS) return res;
    let text: string;
    try {
      text = await res.text();
    } catch {
      return res;
    }
    const facts = refusalFactsOf(res.status, text);
    if (facts !== null) raiseAccessLock(facts);
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
