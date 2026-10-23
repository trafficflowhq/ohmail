import { Blob as NodeBlob, File as NodeFile } from "node:buffer";

/**
 * A TEST DATABASE OPENED UNDER JSDOM. PGlite reads the migrated template through
 * `Blob.arrayBuffer()` and dumps it through `File`, and jsdom's Blob has no `arrayBuffer`: opened
 * there, the template reads as corrupt, the shared copy in the temp dir is deleted and the rebuild
 * fails. So the database is opened with Node's own Blob and File, and jsdom's are back before the
 * shell renders. The template stays on, as for every other test (`test/pglite-template-env-census.test.ts`).
 */
export async function withNodeBlobs<T>(open: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { Blob: unknown; File: unknown };
  const jsdom = { Blob: g.Blob, File: g.File };
  g.Blob = NodeBlob;
  g.File = NodeFile;
  try {
    return await open();
  } finally {
    g.Blob = jsdom.Blob;
    g.File = jsdom.File;
  }
}
