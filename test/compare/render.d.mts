import type { Browser, BrowserContext, BrowserType, Page } from "@playwright/test";
import type { Scene, Variant } from "./scene.d.mts";

/** `tolerance.json`: how far two readings may differ, and what holds the rendering still. */
export interface Tolerance {
  /** Q2: CSS pixels a box's edge or size may differ by. */
  box: number;
  /** Q4: the share of the whole picture's pixels that may differ. */
  pictureRatio: number;
  /** Q4: the share of one node's region that may differ. */
  regionRatio: number;
  /** Q4: the share of the whole picture over which any state fails, accepted or not. */
  grossRatio: number;
  /** Q4: the most differing pixels of the picture that may touch one another. */
  mark: number;
  /** Q4: the least side of a node's region, in CSS pixels. */
  regionFloor: number;
  /** Q4: how far one pixel may differ before it counts (pixelmatch's threshold, on YIQ). */
  pixel: number;
  /** When a page counts as standing still: unchanged over `quietMs`, reached within `withinMs`. */
  settle: { quietMs: number; withinMs: number };
  playwright: string;
  chromiumArgs: string[];
  studioTag: string;
  studioCommit: string;
}

export const TOLERANCE: Tolerance;
/** A file of the page did not arrive; drawing the state again may succeed. */
export class RequestLost extends Error {}
export function launch(chromium: BrowserType): Promise<Browser>;
export function shoot(
  browser: Browser,
  variant: Variant,
  open: (page: Page) => Promise<void>,
  hooks?: { prepare?: (context: BrowserContext) => Promise<unknown>; mayFail?: (url: string) => boolean },
): Promise<{ png: Buffer; scene: Scene }>;
