/**
 * REMOTE PICTURES ON A DOOR WITH NO ORIGIN.
 *
 * The window's engine is reached over Tauri's command channel, not a port — `bridge-fetch.ts`
 * says why, and the posture stands: nothing listens, so no `<img src>` can name the proxy the
 * way the hosted client does. The bytes travel the same road every mail body and attachment
 * already takes, and reach the frame as a `data:` URI, which the frame's policy has always
 * admitted. No port, no token in the page, and `frameCsp` does not move.
 *
 * The FETCH itself is the local door's `GET /img` — the same `PrivacyService.proxyImage` the
 * hosted door runs, with the SSRF gate, the beacon refusal, the timeout and the size cap. This
 * module adds no policy of its own; it is a transport and nothing else.
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
 * Resolves to a `data:` URI, or `null` for every refusal — the SSRF gate, an account that opted
 * out, a beacon, a non-image type, a transport failure. ONE return value for all of them on
 * purpose: the caller's only move is the blanked box, and a thrown error here would have to be
 * classified by a renderer that cannot act on the difference. The door logs which arm refused.
 *
 * `mid` is the AUTHORISATION, not a decoration: the proxy refuses a message this account does
 * not own, so the id is what makes the url fetchable at all.
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
