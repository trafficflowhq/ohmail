/**
 * THE PALETTE'S OFFERS, by the part that hands them: each mounted part's feed, the source on screen first, then
 * `OFFER_SOURCES`' order, each source's parts in the order they came. A part that goes takes its feed with it.
 */
import { OFFER_SOURCES, type OfferFeed, type PaletteOffer } from "./contract.js";
import { createFeed, type Feed } from "./feeds.js";

export interface OfferStore {
  readonly feeds: Feed<readonly OfferFeed[]>;
  /** The part `id`'s feed, or null when it goes. */
  post(id: string, feed: OfferFeed | null): void;
}

const rank = (feed: OfferFeed) =>
  (feed.onScreen ? 0 : 1) * OFFER_SOURCES.length + OFFER_SOURCES.indexOf(feed.source);

export function createOfferStore(): OfferStore {
  const byPart = new Map<string, OfferFeed>();
  const feeds = createFeed<readonly OfferFeed[]>([]);
  return {
    feeds,
    post(id, feed) {
      if (feed === null) byPart.delete(id);
      else byPart.set(id, feed);
      /* A stable sort: within one rank, the order the parts came in. */
      feeds.set([...byPart.values()].sort((a, b) => rank(a) - rank(b)));
    },
  };
}

/** What the palette draws of an offer: everything but `run`, which is read at the press. */
export function shapeOf(offers: readonly PaletteOffer[]): string {
  return JSON.stringify(offers.map((o) => [o.id, o.label, o.icon, o.chord ?? "", o.disabled === true]));
}
