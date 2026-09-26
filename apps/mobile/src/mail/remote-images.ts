/**
 * THE CONSENTED REMOTE-IMAGE FETCH — the phone's one road for a sender-named picture, taken
 * only on the reader's own "Show images" press. The DOCUMENT never gains network: every fetched
 * image is minted to a gated `data:` URI under the engine's inline-image ceilings. On a paired
 * door the picture comes through that server's `GET /img`, the proxy the web uses, so the image
 * host sees the server; on the standalone door there is no server, this phone dials, and the
 * notice says so before the press ({@link imagesSeenBy}).
 */

import {
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_PARTS,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_IMAGE_SRC,
  REMOTE_URL,
} from "@ohmail/client-engine";
import type { FetchLike } from "../net/bearer";
import type { ConnectedSession } from "../net/pairing";
import { requestBase } from "../net/request-base";
import { blobToBase64 } from "./blob-base64";

/** The four raster types a fetched image may carry into the document — the mint's own set. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Who dials the sender's image host for this session. `proxy` is the paired server's `/img`
 * (`flavor` says whose machine that is); `phone` is the standalone door; `none` is no session.
 */
export type ImageRoute =
  | { via: "proxy"; base: string; fetch: FetchLike; flavor: string }
  | { via: "phone" }
  | { via: "none" };

/** The route a connected session gives its pictures. */
export function imageRouteOf(
  session: Pick<ConnectedSession, "standalone" | "fetch" | "profile">,
): ImageRoute {
  if (session.standalone) return { via: "phone" };
  return { via: "proxy", base: requestBase(session), fetch: session.fetch, flavor: session.profile.flavor };
}

/**
 * Whose network address a sender's image host sees once pictures load — `null` where a server
 * the reader does not sit at fetches them (the hosted service, a self-hosted server), which is
 * the case the help page's claim describes. A desktop host fetches from the reader's computer.
 */
export function imagesSeenBy(route: ImageRoute): "phone" | "computer" | null {
  if (route.via === "phone") return "phone";
  if (route.via === "proxy" && route.flavor !== "managed" && route.flavor !== "selfhost") return "computer";
  return null;
}

/** What one fetch pass minted, and whether the server refused to record the press at all. */
export interface RemoteImagesResult {
  minted: Map<string, string>;
  consentRefused: boolean;
}

/**
 * Fetch the message's blocked remote PICTURES and mint each to a `data:` URI, in document
 * order so the budget is spent on what the reader sees first. Never rejects; a part that
 * cannot be fetched, is not a raster, or is over a ceiling is absent from the map — a blank
 * box. On a proxy door the press is recorded first (`POST /messages/:id/load-remote`, the
 * server's own gate for `/img`), unless the stored body already carries it.
 */
export async function fetchRemoteImages(
  route: ImageRoute,
  messageId: string,
  urls: readonly string[],
  opts: { consented: boolean },
): Promise<RemoteImagesResult> {
  const minted = new Map<string, string>();
  if (route.via === "none") return { minted, consentRefused: false };
  if (route.via === "proxy" && !opts.consented && !(await recordConsent(route, messageId))) {
    return { minted, consentRefused: true };
  }
  let budget = INLINE_IMAGE_MAX_TOTAL_BYTES;
  for (const url of urls) {
    if (minted.size >= INLINE_IMAGE_MAX_PARTS) break;
    if (minted.has(url) || !REMOTE_URL.test(url)) continue;
    try {
      const res = route.via === "proxy"
        ? await route.fetch(
          `${route.base}/img?mid=${encodeURIComponent(messageId)}&u=${encodeURIComponent(url)}`,
          { method: "GET" },
        )
        : await fetch(url, { redirect: "follow" });
      if (!res.ok) continue;
      const blob = await res.blob();
      const type = (blob.type || "").toLowerCase().split(";")[0]!.trim();
      if (!RASTER.has(type)) continue;
      if (blob.size === 0 || blob.size > INLINE_IMAGE_MAX_BYTES || blob.size > budget) continue;
      const uri = `data:${type};base64,${await blobToBase64(blob)}`;
      // The same gate the write into the document applies — minted here, asserted there.
      if (!INLINE_IMAGE_SRC.test(uri)) continue;
      budget -= blob.size;
      minted.set(url, uri);
    } catch {
      // An unreachable host is a blank box, never an error screen.
    }
  }
  return { minted, consentRefused: false };
}

/** The press, on the server that fetches: `true` once it answered 2xx. */
async function recordConsent(route: Extract<ImageRoute, { via: "proxy" }>, messageId: string): Promise<boolean> {
  try {
    const res = await route.fetch(
      `${route.base}/messages/${encodeURIComponent(messageId)}/load-remote`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    return res.ok;
  } catch {
    return false;
  }
}
