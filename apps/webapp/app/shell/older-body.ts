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
 * ── THE SHAPE IS THE JUNK WINDOW'S, ON PURPOSE ──────────────────────────────────────────────
 *
 * `shell/junk-window.ts` already solved "a body for a row that must never enter the mirror":
 * fetch on open, hold the answer for THIS SESSION in the hook's own state, one fetch per row per
 * session, a human Retry replaces whatever is held, and a per-row ask generation so a hung first
 * request's late failure cannot overwrite the retry's delivered body. This module is that
 * pattern pointed at `GET /messages/:id/body` — the same stored row the mirror path reads, so
 * redaction, the withheld markers and the unsubscribe posture cannot fork between the two doors.
 * Nothing here writes to the mirror or to IndexedDB: closing the app forgets it, which is
 * exactly the lifetime the rows themselves have.
 *
 * ── THE STATES ARE `MessageBody`'S OWN, so the pane needs no second vocabulary ──────────────
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
 */

import { useCallback, useRef, useState } from "react";
import type { MessageBody, UnsubscribeHeaderState, WithheldMarker } from "@ohmail/client-engine";
import { api, ApiError, apiConfigured } from "../api-client";

/** What one settled ask holds. `gone` is the 404/410 terminal — see the header. */
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
 * The one call this door makes, behind a seam so the desktop can hand in its bridge — the
 * `ConsentTransport` rule: the STATES and their meanings are decided above this seam and cannot
 * be varied by supplying a wire; only the bytes' route differs. A wire REJECTS for a retryable
 * failure (network, 5xx) and answers `{ kind: "gone" }` for the terminal 404/410.
 */
export interface OlderBodyWire {
  body(messageId: string): Promise<OlderBodyOutcome>;
}

/**
 * Narrow the stored-body wire to the door's outcome — the same forward-compatible reading
 * `HttpAdapter`'s `narrowBody` performs for the mirror path, restated here because that function
 * is private to the adapter and this module deliberately does not reach into it. A field the
 * server stops sending must never become `undefined` rendered into a page; a marker outside the
 * closed set reads as an ordinary body; the raw `headers` the route also serves are dropped on
 * the floor — they never enter this session state, exactly as they never enter the mirror.
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
 * The hosted transport — the browser asking the API this app was written against. The same
 * `GET /messages/:id/body` the engine's adapter uses for mirror rows: ownership is proven
 * server-side through `messages`, and the withheld markers ride the same field.
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

type Held =
  | { phase: "loading"; attempt: number }
  | { phase: "settled"; outcome: OlderBodyOutcome }
  | { phase: "failed" };

export interface OlderBodyDoor {
  /** Is there a wire behind this door at all? False ⇒ `bodyFor`/`open` are inert. */
  available: boolean;
  /** The `MessageBody` the pane renders for a reach-past row — see the header for the states. */
  bodyFor(m: { id: string; snippet: string }): MessageBody;
  /**
   * Fetch on show. One ask per row per session; `retry: true` REPLACES whatever is held — the
   * human's press must dispatch even while a hung first ask still reads `loading` (the junk
   * window's measured finding, inherited rather than re-learned).
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
  const [held, setHeld] = useState<Map<string, Held>>(() => new Map());
  /** Per-row ask generation — a superseded ask's completion must not overwrite its successor's. */
  const gen = useRef(new Map<string, number>());
  /** The wire behind a stable identity — `consent-state.ts`'s `link`, for the same reason. */
  const link = useRef<OlderBodyWire | undefined>(wire);
  link.current = wire;

  const open = useCallback((messageId: string, opts: { retry?: boolean } = {}) => {
    const w = link.current;
    if (w === undefined) return;
    setHeld((cur) => {
      const have = cur.get(messageId);
      // One fetch per session per row: `loading` and any settled answer are both answers. A
      // human Retry overrides `loading` and `failed` — but never a SETTLED outcome, because
      // `full` and `withheld` render no Retry and a re-ask would be a poll with nobody behind it.
      if (have && have.phase === "settled") return cur;
      if (have && !opts.retry) return cur;
      const mine = (gen.current.get(messageId) ?? 0) + 1;
      gen.current.set(messageId, mine);
      void w.body(messageId).then(
        (outcome) =>
          setHeld((m) =>
            gen.current.get(messageId) === mine
              ? new Map(m).set(messageId, { phase: "settled", outcome })
              : m,
          ),
        () =>
          setHeld((m) =>
            gen.current.get(messageId) === mine
              ? new Map(m).set(messageId, { phase: "failed" })
              : m,
          ),
      );
      return new Map(cur).set(messageId, { phase: "loading", attempt: mine });
    });
  }, []);

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
