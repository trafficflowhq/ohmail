import type { Subject } from "../subject.js";

/**
 * The screen `trash` is compared by the place's own parts, never whole
 * (`packages/app/test/compare/places-parts.compare.ts`): the reference stands the place between the frame's rail and a
 * reading column, which are the frame's and the reader's. This file names the screen's shard to `fetch.mjs`, as every
 * screen with a file here; it holds no whole state, and the parts' comparison checks each picture it reads against the
 * manifest.
 */
export const subjects: Subject[] = [];
