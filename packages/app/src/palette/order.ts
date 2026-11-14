/**
 * THE PALETTE'S ROWS, in the feed's order (the source on screen first, then each source in its own order), as the
 * kit's palette draws them.
 */
import type { PaletteCommand } from "@ohmail/ui/base";
import type { BoundKey } from "@ohmail/app-logic/keys";
import type { OfferFeed } from "../frame/contract.js";
import { keysOf } from "./keys-of.js";

export function rowsOf(
  feeds: readonly OfferFeed[],
  bindings: readonly BoundKey[],
  mod: string,
): PaletteCommand[] {
  const seen = new Set<string>();
  const rows: PaletteCommand[] = [];
  for (const feed of feeds)
    for (const offer of feed.read()) {
      /* One id is one command: a second part handing the same id is not listed twice. */
      if (seen.has(offer.id)) continue;
      seen.add(offer.id);
      const keys = keysOf(offer.chord, bindings, mod);
      rows.push({
        id: offer.id,
        label: offer.label,
        icon: offer.icon,
        ...(keys ? { keys } : {}),
        ...(offer.disabled ? { disabled: true } : {}),
      });
    }
  return rows;
}

/** The offer with this id as it stands now, read at the press; none while it is disabled. */
export function liveOffer(feeds: readonly OfferFeed[], id: string) {
  for (const feed of feeds) {
    const offer = feed.read().find((o) => o.id === id);
    if (offer) return offer.disabled ? null : offer;
  }
  return null;
}
