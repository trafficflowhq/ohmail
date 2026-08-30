"use client";

/**
 * THE REACH-PAST BODY DOOR — a session-held body for the rows `useOlderMail` fetched from beyond
 * the mirror window.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * A reach-past row is deliberately NOT a mirror row (`older-mail.ts`: no sync sequence, nothing
 * to reconcile, the next prune would evict it). The engine's own body machinery keys on the
 * mirror — `bodyPlan` answers `skip` for a message id the mirror does not hold — so opening a
 * reach-past row never issued a request at all: the pane's stall timer expired over a fetch that
 * had never started, rendered "Couldn't load the full message — showing the preview" with a
 * Retry, and the Retry re-ran the same skip. A control whose promise could never be kept.
 *
 * ── THE MECHANICS ARE THE ENGINE'S, THIS FILE IS THE BIND ───────────────────────────────────
 *
 * The session-cache pattern — single-flight decided outside any state updater, one ask per row
 * per session, a human Retry that replaces a hung ask but never a settled answer, per-row ask
 * generations — is `createSessionBodyDoor` (`@ohmail/client-engine`, the Content Door's
 * on-demand arm; its header carries the review-caught findings this file used to carry). What
 * lives HERE is only what is this door's own: the wire (the browser's Cloud client), the
 * `reopenFailed: false` policy (this door's `open` fires on every render of the row, so a
 * failed row re-asks only on the human press), and the rendering of the held phases into
 * `MessageBody` — the pane's own vocabulary, so it needs no second one:
 *
 *  · not asked yet   → `snippet` (the surface asks via `open` the moment the row is shown);
 *  · in flight       → `loading`;
 *  · delivered       → `full`, html and unsubscribe posture included;
 *  · policy-emptied  → `withheld` with the server's own marker — the pane already owes each
 *                      member its own sentence and offers no Retry, which is the honest terminal;
 *  · 404/410         → `withheld: "expunged"`. The list handed us this id and the account no
 *                      longer holds the row — the stored copy is gone, a retry cannot change it,
 *                      and the expunged sentence says exactly that. Never `failed`: `failed`
 *                      offers a Retry, and a Retry that cannot work is the defect this module
 *                      exists to remove;
 *  · transport/5xx   → `failed` — here the Retry is real: `open(id, { retry: true })` dispatches
 *                      a fresh request even while a hung first ask still shows `loading`.
 *
 * Nothing here writes to the mirror or to IndexedDB: closing the app forgets it, which is
 * exactly the lifetime the rows themselves have.
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
 * @param active `false` on the demo — a self-contained surface makes no external request, and
 * its fixture rows carry their bodies anyway.
 * @param transport A host's own wire — the desktop's hosted door hands in its bridge. Absent ⇒
 * the browser's Cloud client where one is configured (`apiConfigured()` is answered HERE, by the
 * module that owns the client — the shared shell never imports it; the desktop's alias stubs it
 * to false, so a desktop build that forgets to inject simply has no door rather than a broken
 * one). Must be stable-ish: it is read through a ref, `consent-state.ts`'s rule.
 */
export function useOlderBody(active: boolean, transport?: OlderBodyWire): OlderBodyDoor {
  const wire = active ? transport ?? (apiConfigured() ? CLOUD_OLDER_BODY : undefined) : undefined;
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
