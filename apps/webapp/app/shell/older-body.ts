"use client";

/**
 * The reach-past body door — a session-held body for the rows `useOlderMail` fetched from beyond the mirror window. A
 * reach-past row is deliberately not a mirror row, and the engine's body machinery keys on the mirror (`bodyPlan`
 * answers `skip` for an id the mirror does not hold), so opening one never issued a request: the stall timer expired
 * over a fetch that never started, rendered "Couldn't load the full message" with a Retry, and the Retry re-ran the
 * same skip — a control whose promise could never be kept.
 */

/**
 * The mechanics are the engine's (`createSessionBodyDoor`); what lives here is this door's own: the wire, the
 * `reopenFailed: false` policy (a failed row re-asks only on the human press), and the rendering of held phases into
 * `MessageBody`'s own vocabulary.
 */

/**
 * The phases: not asked → `snippet` (the surface asks via `open` when the row shows); in flight →
 * `loading`; delivered → `full`; policy-emptied → `withheld` with the server's marker (no Retry, the
 * honest terminal); 404/410 → `withheld: "expunged"` — the account no longer holds the row, a
 * retry cannot change it, and `failed` would offer a Retry that cannot work, the exact defect this
 * module removes; transport/5xx → `failed`, where the Retry is real (`open(id, { retry: true })`
 * dispatches a fresh request even while a hung first ask still shows `loading`). Nothing writes to
 * the mirror or IndexedDB: closing the app forgets it — the rows' own lifetime.
 */

import { useCallback, useRef, useState } from "react";
import {
  createSessionBodyDoor, narrowOlderBody,
  type MessageBody, type OlderBodyOutcome, type OlderBodyWire, type SessionBodyHeld,
  type WithheldMarker,
} from "@ohmail/client-engine";
import { api, ApiError, apiConfigured } from "../api-client";

// The seam types are the engine's now; re-exported so this door's consumers (`AppShell`, the
// desktop's transports) keep importing them from the door they bind.
export { narrowOlderBody, type OlderBodyOutcome, type OlderBodyWire };

/**
 * The hosted transport — the browser asking the API this app was written against. The same
 * `GET /messages/:id/body` the engine's adapter uses for mirror rows: ownership is proven
 * server-side through `messages`, and the withheld markers ride the same field. Not
 * `olderBodyVia`: the Cloud client's `api()` carries the session's own error contract
 * (`ApiError` with the status), so the narrowing binds to that rather than to a raw Response.
 */
export const CLOUD_OLDER_BODY: OlderBodyWire = {
  body: async (messageId) => {
    try {
      return narrowOlderBody(
        await api<Record<string, unknown>>(`/messages/${encodeURIComponent(messageId)}/body`),
      );
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        return { kind: "gone" };
      }
      throw err;
    }
  },
};

export interface OlderBodyDoor {
  /** Is there a wire behind this door at all? False ⇒ `bodyFor`/`open` are inert. */
  available: boolean;
  /** The `MessageBody` the pane renders for a reach-past row — see the header for the states. */
  bodyFor(m: { id: string; snippet: string }): MessageBody;
  /**
   * Fetch on show. One ask per row per session; `retry: true` REPLACES whatever is held — the
   * human's press must dispatch even while a hung first ask still reads `loading` (the junk
   * window's measured finding, inherited through the shared door rather than re-learned).
   */
  open(messageId: string, opts?: { retry?: boolean }): void;
}

/** A resting `MessageBody` in one expression — every non-full state shares this shape. */
function resting(text: string, state: MessageBody["state"], withheld?: WithheldMarker): MessageBody {
  return {
    text,
    state,
    html: null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
    ...(withheld !== undefined ? { withheld } : {}),
  };
}

/**
 * @param active `false` on the demo — a self-contained surface makes no external request, and its fixture rows carry
 * their bodies anyway. @param transport A host's own wire — the desktop's hosted door hands in its bridge. Absent ⇒
 * the browser's Cloud client where one is configured (`apiConfigured()` is answered HERE, by the module that owns the
 * client — the shared shell never imports it; the desktop's alias stubs it to false). Read through a ref,
 * `consent-state.ts`'s rule. @param mayRead Asked immediately before every request, never cached. `false` ⇒ the ask
 * FAILS rather than being skipped — the difference between a row that says "couldn't load" and one that sits on its
 * snippet with no explanation and no retry.
 */

/**
 * Why this door needs its own answer: every other read reaches the server through the engine's
 * adapter, which the mirror's sync gate wraps — when the browser's session belongs to a
 * different account than the mirror on screen, those reads refuse in one place. This door is a
 * bare `api()` call, because a reach-past row is by definition not in the mirror. That made it
 * the widest door: under a foreign session `useOlderMail`'s list is that account's mail, the id
 * handed here is valid, the request succeeds, and the pane renders somebody else's message in
 * full. So the caller supplies the predicate (`syncIdentityOf`, `sync-scheduler.ts`); this file
 * stays free of any opinion about sessions, which keeps it usable by the desktop's hosted door.
 */
export function useOlderBody(
  active: boolean,
  transport?: OlderBodyWire,
  mayRead?: () => boolean,
): OlderBodyDoor {
  const base = active ? transport ?? (apiConfigured() ? CLOUD_OLDER_BODY : undefined) : undefined;
  const wire: OlderBodyWire | undefined = base && mayRead
    ? {
      body: async (messageId) => {
        if (!mayRead()) {
          throw new Error("ohmail: this browser's session now belongs to another account");
        }
        return base.body(messageId);
      },
    }
    : base;
  const [held, setHeld] = useState<ReadonlyMap<string, SessionBodyHeld<OlderBodyOutcome>>>(
    () => new Map(),
  );
  /**
   * The door instance is the session cache, so it must survive re-renders: `useState`'s lazy
   * initializer runs once for the mount React keeps (StrictMode's discarded twin never receives
   * an `open` — those come from callbacks and effects, which fire only on the kept mount).
   * `setHeld` is identity-stable, so handing it to the door as `onChange` is safe.
   */
  const [door] = useState(() =>
    createSessionBodyDoor<OlderBodyOutcome>({ onChange: setHeld, reopenFailed: false }),
  );
  /** The wire behind a stable identity — `consent-state.ts`'s `link`, for the same reason. */
  const link = useRef<OlderBodyWire | undefined>(wire);
  link.current = wire;

  const open = useCallback((messageId: string, opts: { retry?: boolean } = {}) => {
    const w = link.current;
    if (w === undefined) return;
    door.open(messageId, () => w.body(messageId), opts);
  }, [door]);

  const bodyFor = useCallback(
    (m: { id: string; snippet: string }): MessageBody => {
      const have = held.get(m.id);
      if (!have) return resting(m.snippet, "snippet");
      if (have.phase === "loading") return resting(m.snippet, "loading");
      if (have.phase === "failed") return resting(m.snippet, "failed");
      const o = have.outcome;
      if (o.kind === "gone") return resting(m.snippet, "withheld", "expunged");
      if (o.withheld !== null) return resting(m.snippet, "withheld", o.withheld);
      return {
        text: o.text,
        state: "full",
        html: o.html,
        loadedRemoteContent: o.loadedRemoteContent,
        unsubscribe: o.unsubscribe,
        unsubscribeUrl: o.unsubscribeUrl,
      };
    },
    [held],
  );

  return { available: wire !== undefined, bodyFor, open };
}
