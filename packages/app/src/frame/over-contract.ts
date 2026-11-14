/**
 * WHAT STANDS OVER EVERY PLACE, in the frame's contract (re-exported by `contract.ts`): the overs a shell hands in
 * and the offers a product hands the palette.
 */
import type { ComponentType } from "react";
import type { IconName } from "@ohmail/ui/base";
import type { None } from "../host/index.js";

/**
 * THE OVERS: what stands over every place and is no place (the command palette, the key sheet). A shell imports
 * each and hands it in, or `none`; the frame mounts every handed `Body` always, inside its root, open while the
 * frame's `over` names it. One stands at a time. A host hands an over only under a keyboard registry (a
 * `KeymapProvider` above the frame): each Body declares its own key there and throws without one.
 */
export const OVER_IDS = ["palette", "keys"] as const;
export type OverId = (typeof OVER_IDS)[number];
export interface OverProps {
  readonly open: boolean;
  readonly onClose: () => void;
}
export interface OverEntry {
  readonly id: OverId;
  readonly Body: ComponentType<OverProps>;
}
export type FrameOvers = Readonly<Record<OverId, OverEntry | None>>;

/**
 * HOW A PRODUCT HANDS THE PALETTE ITS COMMANDS. A source is a product of the app; the source on screen comes first.
 * A `label` is in the person's language already; a `chord` is the keyboard registry's notation, and its keys are
 * printed only while the registry holds a binding with that chord (no hint is typed by hand).
 */
export const OFFER_SOURCES = ["mail", "calendar"] as const;
export type OfferSource = (typeof OFFER_SOURCES)[number];
export interface PaletteOffer {
  /** `<source>.<verb>`, stable across renders. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly chord?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}
/** One source's offers as the palette reads them: the shape for drawing, `read()` at the press for the live `run`. */
export interface OfferFeed {
  readonly source: OfferSource;
  readonly onScreen: boolean;
  /** The offers' shape (ids, labels, icons, chords, disabled); a new value only when that moves. */
  readonly shape: string;
  read(): readonly PaletteOffer[];
}
