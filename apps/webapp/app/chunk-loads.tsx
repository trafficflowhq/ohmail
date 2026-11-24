"use client";

import type { ReactNode } from "react";
import { ChunkLoadContext } from "@ohmail/app/frame";

export const page = { reload: (): void => { window.location.reload(); } };
const remedy = { replaced: buildReplaced, reload: () => page.reload() };

export function BrowserChunkLoads({ children }: { children: ReactNode }) {
  return <ChunkLoadContext.Provider value={remedy}>{children}</ChunkLoadContext.Provider>;
}


/**
 * AFTER A SERVER UPGRADE an open tab asks for its own build's chunks, and the new server answers 404:
 * the network is fine and Try again fetches the same missing file. A chunk is judged gone only when
 * the server says so (404/410 to a fresh HEAD); a probe that cannot reach it is the connection.
 */
async function buildReplaced(cause: unknown): Promise<boolean> {
  const url = chunkUrl(cause);
  if (url == null) return false;
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

/** The chunk a failed import names: webpack's `request`, or the URL in a browser's import error (or its cause's). */
function chunkUrl(cause: unknown, depth = 0): string | null {
  const c = cause as { request?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  const raw = typeof c?.request === "string" ? c.request
    : typeof c?.message === "string" ? /(?:https?:\/\/|\/_next\/)[^\s)]+/.exec(c.message)?.[0] : undefined;
  return (raw ? ownOrigin(raw) : null) ?? (c?.cause != null && depth < 3 ? chunkUrl(c.cause, depth + 1) : null);
}

/** Where Next serves the build's chunks; next.config sets no basePath or assetPrefix. */
const CHUNK_PREFIX = "/_next/static/";

/** Only this app's own build chunks are asked about: never an /api path or any other URL an error names. */
function ownOrigin(raw: string): string | null {
  if (typeof location === "undefined") return null;
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin && url.pathname.startsWith(CHUNK_PREFIX) ? url.href : null;
  } catch {
    return null;
  }
}
