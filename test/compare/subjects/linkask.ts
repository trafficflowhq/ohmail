import type { Subject } from "../subject.js";

/**
 * The screen `linkask` is compared by the reader's parts, never whole (`packages/app/test/compare/reader-parts.compare.ts`):
 * the reference stands the reader beside the frame's rail and the design's own pages. This file names the screen's
 * shard to `fetch.mjs`, as every screen with a file here; it holds no whole state, and the parts' comparison checks
 * each picture it reads against the manifest.
 */
export const subjects: Subject[] = [];
