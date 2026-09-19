/**
 * The frame's navigation rule — pure, so the suite drives it directly. The WebView calls
 * `onShouldStartLoadWithRequest` for every navigation; everything is refused except the
 * document's own load, and a link press (which arrives as an `ohmail-link:<n>` token — the
 * document carries no real URL, see `sanitize.ts#links`) maps back through the table to the
 * confirm sheet. A token outside the table, a malformed index, or any other scheme is a plain
 * refusal: on this surface an unknown navigation is an attack shape, never a feature.
 */

import { SAFE_HREF } from "@ohmail/client-engine";
import { PHONE_LINK_SCHEME } from "./sanitize";

export type FrameNavDecision =
  | { kind: "load" }
  | { kind: "refuse" }
  | { kind: "confirm"; url: string };

/** The url shapes the initial `source={{ html }}` load presents, per platform. */
const DOCUMENT_LOAD = /^(?:about:blank$|data:text\/html)/i;

export function frameNavDecision(url: string, links: readonly string[]): FrameNavDecision {
  if (DOCUMENT_LOAD.test(url)) return { kind: "load" };
  if (url.toLowerCase().startsWith(PHONE_LINK_SCHEME)) {
    const raw = url.slice(PHONE_LINK_SCHEME.length);
    // An INDEX, exactly — `parseInt` admits "1junk" and a plus sign admits a second spelling.
    if (!/^\d{1,6}$/.test(raw)) return { kind: "refuse" };
    const target = links[Number(raw)];
    // The gate is re-asked at the exit, not only at the write: the table is a prop, and
    // "the sanitizer is the only writer" is today's wiring, not a property of this function.
    if (target === undefined || !SAFE_HREF.test(target) || /^cid:/i.test(target)) {
      return { kind: "refuse" };
    }
    return { kind: "confirm", url: target };
  }
  return { kind: "refuse" };
}
