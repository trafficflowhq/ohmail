/**
 * A Blob's bytes as base64 — what expo-file-system writes and what a `data:` URI carries.
 * `arrayBuffer()` is native in node (the suite) and supplied on the device by
 * `src/polyfills/blob-arraybuffer.ts` (React Native 0.86's own Blob lacks it), which the app
 * entry installs before anything can hold a Blob.
 */

import { Buffer } from "buffer";

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return Buffer.from(bytes).toString("base64");
}
