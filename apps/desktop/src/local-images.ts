/**
 * REMOTE PICTURES ON A DOOR WITH NO ORIGIN.
 *
 * Nothing listens on a port here — the engine is reached over Tauri's command channel
 * (`bridge-fetch.ts` says why) — so no `<img src>` can name the proxy the way the hosted client
 * does. The bytes take the road mail bodies already take and reach the frame as a `data:` URI,
 * which `frameCsp` has always admitted and does not move for. The fetch is the local door's
 * `GET /img`, the same `PrivacyService.proxyImage` the hosted door runs; this module is
 * transport and adds no policy of its own.
 */

import { bridgeFetch } from "./bridge-fetch.js";

/** What `GET /img` is willing to have been. Anything else is a refusal, not a picture. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/**
 * Bytes → a `data:` URI, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a whole image overflows the call stack somewhere around a
 * hundred thousand arguments — a picture-sized input, not an exotic one — so the spread is taken
 * in slices. `btoa` is the platform's, and the window is a browser.
 */
function dataUri(type: string, bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Fetch one remote picture for one message through this window's engine.
 *
 * Resolves to a `data:` URI, or `null` for every refusal — SSRF gate, opted-out account, beacon,
 * non-image type, transport failure. ONE return value for all of them: the caller's only move is
 * the blanked box, and a thrown error would have to be classified by a renderer that cannot act
 * on the difference. The door logs which arm refused.
 *
 * `mid` is the AUTHORISATION: the proxy refuses a message this account does not own.
 */
export async function localImageWire(messageId: string, url: string): Promise<string | null> {
  try {
    const path = `/img?mid=${encodeURIComponent(messageId)}&u=${encodeURIComponent(url)}`;
    const res = await bridgeFetch(path);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    /* The type is the door's answer, checked here too rather than trusted: a proxy that ever
       served something else must not be able to put it in the frame as a picture. */
    if (!IMAGE_TYPES.has(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return dataUri(type, bytes);
  } catch {
    return null;
  }
}
