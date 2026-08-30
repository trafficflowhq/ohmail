/**
 * THE CONTENT DOOR'S ON-DEMAND ARM — one session-body pattern for every body read the mirror
 * does not answer.
 *
 * ── THE TWO ARMS, STATED ONCE ───────────────────────────────────────────────────────────────
 *
 * Every body read in the system is one of exactly two shapes:
 *
 *  · MIRROR-RESIDENT — the message is in the mirror, so the body is fetched through
 *    {@link OhmailEngine.hydrateBody} (admission decided by `bodyPlan`, single-flight on the
 *    request map, urgent-jumps-queue) and PERSISTED as a `message_body` record. The reading
 *    pane and thread siblings live here.
 *  · ON-DEMAND — the row deliberately never enters the mirror (a reach-past page from beyond
 *    the local window; the junk window's live view of the provider's own \Junk), so the body
 *    is fetched on open, held for THIS SESSION in memory, and NEVER persisted: closing the app
 *    forgets it, which is exactly the lifetime the rows themselves have.
 *
 * This module is the on-demand arm's ONE implementation. The pattern was proven by the junk
 * window and restated by the reach-past door, at which point it existed twice, each copy
 * carrying independently-review-caught fixes the other had to re-learn (the StrictMode
 * double-dispatch, the superseded ask's late failure overwriting a delivered retry). A third
 * surface would have made a third copy. Surfaces now bind a TRANSPORT (which wire carries the
 * bytes) and a RENDERING (what their pane makes of the held phases); the mechanics live here:
 *
 *  · SINGLE-FLIGHT, decided against this module's OWN map, synchronously, before anything
 *    suspends — never inside a React state updater. An updater must stay pure: under
 *    `<StrictMode>` React invokes updaters twice in development, and a first draft that
 *    dispatched the fetch inside one issued TWO requests per open — the generation guard
 *    discarded the loser's ANSWER but the wire had already been billed twice (review-caught).
 *  · ONE ASK PER KEY PER SESSION: `loading` and a settled answer are both answers. A human
 *    Retry (`retry: true`) REPLACES `loading` and `failed` — the press must dispatch even
 *    while a hung first ask is still in flight (measured: the stall face's Retry did nothing
 *    until a reload) — but never a SETTLED outcome: a settled body renders no Retry, so a
 *    re-ask would be a poll with nobody behind it.
 *  · PER-KEY ASK GENERATION: each dispatch takes the key's next generation, and a completion
 *    landing after a newer ask took over is DROPPED — a hung first request's late rejection
 *    must not overwrite the retry's delivered body with `failed`.
 *  · The `attempt` on `loading` is that generation, so a preview can REMOUNT its body anatomy
 *    per try — a retry that reused the mount kept the expired stall timer's "failed" face over
 *    the live second request (review-caught).
 *
 * KEYS are the caller's: the reach-past door keys by message id; the junk window keys by
 * `mailboxId:uidValidity:uid`, epoch-scoped, because a UID names a message only within one
 * UIDVALIDITY — a key without the epoch would alias a recreated folder's reused numbers onto
 * the old rows' cached bodies (the stale body under the new subject).
 *
 * The transport-side counterpart is not here and must not be: which store answers — the
 * mirror, or a forward to the hosted account for a row the mirror never held — is the
 * sidecar's routing decision (`cloud-read.ts` and its engine's fall-through), pinned by its
 * own censuses. Above that seam there are exactly two wire routes (`GET /messages/:id/body`,
 * `GET /messages/bodies`), unchanged by this module's existence.
 */

import type { UnsubscribeHeaderState, WithheldMarker } from "./types.js";

/** What one key holds mid-session. Absent from the map ⇒ never asked (the caller's "idle"). */
export type SessionBodyHeld<Outcome> =
  | { phase: "loading"; attempt: number }
  | { phase: "settled"; outcome: Outcome }
  | { phase: "failed" };

export interface SessionBodyDoor<Outcome> {
  /** The held phase for one key, or undefined when this session never asked. */
  held(key: string): SessionBodyHeld<Outcome> | undefined;
  /** The whole session cache, immutable — a new map per transition, safe to hand to React. */
  snapshot(): ReadonlyMap<string, SessionBodyHeld<Outcome>>;
  /**
   * Fetch on open. Returns whether a request was DISPATCHED — refusals (an answer already
   * held, an ask already in flight without `retry`) return false and change nothing.
   *
   * `ask` is invoked synchronously when admitted, BEFORE the `loading` phase is published, so
   * a synchronous throw escapes to the caller with the session state unchanged — the same
   * contract a bare `wire.body()` call had.
   */
  open(key: string, ask: () => Promise<Outcome>, opts?: { retry?: boolean }): boolean;
}

export interface SessionBodyDoorOptions<Outcome> {
  /** Called after every transition with the new immutable snapshot — the React bind's seam. */
  onChange: (held: ReadonlyMap<string, SessionBodyHeld<Outcome>>) => void;
  /**
   * May an AUTOMATIC (non-retry) open re-ask a `failed` key? The junk window's body-on-open
   * does — its automatic open fires per selection, and a row that failed once should try again
   * when the reader returns to it. The reach-past door does not: its open fires on every
   * render of the row, so re-admitting `failed` there would be a billed retry loop with
   * nobody behind it. A human `retry: true` re-asks `failed` regardless.
   */
  reopenFailed?: boolean;
}

export function createSessionBodyDoor<Outcome>(
  opts: SessionBodyDoorOptions<Outcome>,
): SessionBodyDoor<Outcome> {
  const reopenFailed = opts.reopenFailed === true;
  /** The door's own copy — every admission decision reads THIS, never a React snapshot. */
  let held = new Map<string, SessionBodyHeld<Outcome>>();
  /** Per-key ask generation — a superseded ask's completion must not overwrite its successor's. */
  const gen = new Map<string, number>();

  /** One writer for the map and the notification, in dispatch order, so the two cannot drift. */
  const publish = (key: string, phase: SessionBodyHeld<Outcome>): void => {
    held = new Map(held).set(key, phase);
    opts.onChange(held);
  };

  return {
    held: (key) => held.get(key),
    snapshot: () => held,
    open: (key, ask, openOpts = {}) => {
      const have = held.get(key);
      // A settled outcome is final for the session — `full` and `withheld` render no Retry,
      // and a re-ask would poll a server that will keep answering the same thing.
      if (have !== undefined && have.phase === "settled") return false;
      if (have !== undefined && openOpts.retry !== true && !(have.phase === "failed" && reopenFailed)) {
        return false;
      }
      const mine = (gen.get(key) ?? 0) + 1;
      gen.set(key, mine);
      // Dispatch BEFORE publishing `loading` (a sync throw leaves the session unchanged);
      // everything from the admission check to here is synchronous — the single-flight is
      // this map, and a map consulted after an await is not one.
      const answer = ask();
      void answer.then(
        (outcome) => {
          if (gen.get(key) === mine) publish(key, { phase: "settled", outcome });
        },
        () => {
          if (gen.get(key) === mine) publish(key, { phase: "failed" });
        },
      );
      publish(key, { phase: "loading", attempt: mine });
      return true;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE STORED-BODY WIRE VOCABULARY — the outcome one `GET /messages/:id/body` ask settles to,
 * and the narrowing every transport shares. The webapp's Cloud client, the desktop window's
 * bridge and the LAN host page's bearer socket all answer the same stored row; the narrowing
 * and the status contract live once so redaction, the withheld markers and the unsubscribe
 * posture cannot fork between doors.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** What one settled stored-body ask holds. `gone` is the 404/410 terminal — the row left the account. */
export type OlderBodyOutcome =
  | {
      kind: "ok";
      text: string;
      html: string | null;
      loadedRemoteContent: boolean;
      unsubscribe: UnsubscribeHeaderState;
      unsubscribeUrl: string | null;
      /** The server's own marker when policy emptied the stored body; null for an ordinary row. */
      withheld: WithheldMarker | null;
    }
  | { kind: "gone" };

/**
 * The one call a reach-past door makes, behind a seam so each host hands in its transport —
 * the `ConsentTransport` rule: the STATES and their meanings are decided above this seam and
 * cannot be varied by supplying a wire; only the bytes' route differs. A wire REJECTS for a
 * retryable failure (network, 5xx) and answers `{ kind: "gone" }` for the terminal 404/410.
 */
export interface OlderBodyWire {
  body(messageId: string): Promise<OlderBodyOutcome>;
}

/**
 * Narrow the stored-body wire to the door's outcome — the same forward-compatible reading
 * `HttpAdapter`'s `narrowBody` performs for the mirror path, restated here because that
 * function is private to the adapter and this module deliberately does not reach into it. A
 * field the server stops sending must never become `undefined` rendered into a page; a marker
 * outside the closed set reads as an ordinary body; the raw `headers` the route also serves
 * are dropped on the floor — they never enter this session state, exactly as they never enter
 * the mirror.
 */
export function narrowOlderBody(wire: {
  text?: unknown;
  html?: unknown;
  loadedRemoteContent?: unknown;
  unsubscribe?: unknown;
  unsubscribeUrl?: unknown;
  withheld?: unknown;
}): OlderBodyOutcome {
  return {
    kind: "ok",
    text: typeof wire.text === "string" ? wire.text : "",
    html: typeof wire.html === "string" ? wire.html : null,
    loadedRemoteContent: wire.loadedRemoteContent === true,
    unsubscribe:
      wire.unsubscribe === "one_click" ||
      wire.unsubscribe === "mailto_only" ||
      wire.unsubscribe === "not_one_click"
        ? wire.unsubscribe
        : "no_header",
    unsubscribeUrl: typeof wire.unsubscribeUrl === "string" ? wire.unsubscribeUrl : null,
    withheld:
      wire.withheld === "storage_cap" || wire.withheld === "junk_filed" || wire.withheld === "expunged"
        ? wire.withheld
        : null,
  };
}

/**
 * The wire over ANY fetch-shaped transport — the desktop window hands in its bridge, and the
 * LAN host client hands in its bearer fetch, because that page's engine also lists reach-past
 * rows over a bounded in-memory mirror and a door nobody wires there is the stalled Retry all
 * over again. The browser's Cloud client is NOT this function: its `api()` carries the
 * session's own error contract, so it narrows through {@link narrowOlderBody} directly.
 */
export function olderBodyVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): OlderBodyWire {
  return {
    body: async (messageId) => {
      const res = await fetchImpl(`/messages/${encodeURIComponent(messageId)}/body`);
      if (res.status === 404 || res.status === 410) return { kind: "gone" };
      if (!res.ok) {
        let said: string | undefined;
        try {
          said = ((await res.json()) as { error?: { message?: string } }).error?.message;
        } catch {
          /* Not JSON, or an empty body. The status is all there is. */
        }
        throw new Error(said ?? `the mail engine answered ${res.status}`);
      }
      return narrowOlderBody((await res.json()) as Record<string, unknown>);
    },
  };
}
