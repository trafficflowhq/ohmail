/**
 * A subject: one state of the product, and how to draw it.
 *
 * A file in `subjects/` exports `subjects`. Named after a registered screen (`subjects/ohbox.ts`), its
 * keys are that screen's keys in `registry.json` and each is compared with its reference picture; the
 * file's name is also the archive shard the run fetches. Named otherwise, its keys start with `own:` and
 * each is compared with the product's own picture in `own/`.
 *
 * `open` draws the state and returns; the runner waits for the page to stand still. The window, the scale
 * and the scheme come from the picture's own row, handed in as `variant`: a subject never picks a size.
 */
import type { Page } from "@playwright/test";
import type { Variant } from "./scene.d.mts";

export type { Variant };

export interface Subject {
  key: string;
  open(page: Page, variant: Variant): Promise<void>;
}

/** A row of `own/rows.json`: one of the product's own pictures, and what it was drawn in. */
export interface OwnRow {
  key: string;
  /** The picture is `own/<file>.png`, its data file `own/<file>.json`. */
  file: string;
  variant: Variant;
}
