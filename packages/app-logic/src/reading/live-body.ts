"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * LOAD IT NOW — the text of a letter emptied for space, read from the person's mail server for this
 * view (`GET /messages/:id/live-body`). The answer lives in view state only: never the engine's store,
 * never a mirror, gone when the reader moves on. The transport is the host's: the browser's Cloud
 * client, the desktop's bridge; a host with no wire offers no Load it now.
 */

export type LiveBodyRefusal = "gone" | "too_large" | "busy" | "unreachable" | "failed";

export type LiveBodyOutcome =
  | { kind: "loaded"; text: string; html: string | null }
  | { kind: "refused"; reason: LiveBodyRefusal };

export type LiveBodyWire = (messageId: string) => Promise<LiveBodyOutcome>;

export const liveBodyPath = (messageId: string): string => `/messages/${encodeURIComponent(messageId)}/live-body`;

/** The route's answer, narrowed: text is a string, html a string or nothing. */
export function liveBodyLoaded(raw: unknown): LiveBodyOutcome {
  const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (r === null || typeof r.text !== "string") return { kind: "refused", reason: "failed" };
  return { kind: "loaded", text: r.text, html: typeof r.html === "string" ? r.html : null };
}

/** A refused read by its status: gone (404/410), too large (413), throttled (429), server unreachable. */
export function liveBodyRefused(status: number): LiveBodyOutcome {
  const reason: LiveBodyRefusal = status === 404 || status === 410 ? "gone"
    : status === 413 ? "too_large"
      : status === 429 ? "busy"
        : status === 424 || status === 503 || status === 504 || status === 0 ? "unreachable"
          : "failed";
  return { kind: "refused", reason };
}

/** A wire over a `fetch`-shaped transport (the desktop's bridge). */
export function liveBodyVia(fetcher: (path: string) => Promise<Response>): LiveBodyWire {
  return async (messageId) => {
    let res: Response;
    try {
      res = await fetcher(liveBodyPath(messageId));
    } catch {
      return liveBodyRefused(0);
    }
    if (!res.ok) return liveBodyRefused(res.status);
    try {
      return liveBodyLoaded(await res.json());
    } catch {
      return liveBodyRefused(500);
    }
  };
}

export type LiveBodyState =
  | { state: "idle" } | { state: "loading" } | LiveBodyOutcome;

/** The load for one message, in view state: a new message starts idle, a late answer for another is dropped. */
export function useLiveBody(messageId: string, wire: LiveBodyWire | undefined): {
  live: LiveBodyState; load: (() => void) | null;
} {
  const [held, setHeld] = useState<{ id: string; live: LiveBodyState }>({ id: messageId, live: { state: "idle" } });
  const current = useRef(messageId);
  current.current = messageId;
  useEffect(() => () => { current.current = ""; }, []);
  const load = useCallback(() => {
    if (!wire) return;
    const id = messageId;
    setHeld({ id, live: { state: "loading" } });
    void wire(id).then((out) => {
      if (current.current === id) setHeld({ id, live: out });
    }, () => {
      if (current.current === id) setHeld({ id, live: { kind: "refused", reason: "failed" } });
    });
  }, [wire, messageId]);
  const live = held.id === messageId ? held.live : { state: "idle" as const };
  return { live, load: wire ? load : null };
}
