/**
 * A Blob's bytes as base64 — what expo-file-system writes and what a `data:` URI carries.
 * `arrayBuffer()` is native in node (the suite) and supplied on the device by
 * `src/polyfills/blob-arraybuffer.ts` (React Native 0.86's own Blob lacks it), which the app
 * entry installs before anything can hold a Blob.
 */

import { Buffer } from "buffer";

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Bytes already read, as base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
