/**
 * The tile press's NATIVE half — expo-file-system + expo-sharing, in a `*-native.ts` twin the
 * suite never imports (the standing rule: Expo packages ship Flow-typed JS the node toolchain
 * cannot parse). The bytes land in the app's own cache under a sanitized name and the platform
 * share sheet takes the file — the viewer, save, and send routes are the platform's own. The
 * cache directory is system-evictable, which is the right home for a copy whose master is the
 * mailbox.
 */

import { Buffer } from "buffer";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { shareFilename } from "./open-attachment";

/** Write the bytes and raise the share sheet. `false` = the platform refused, tile says so. */
export async function shareAttachmentBytes(base64: string, mime: string, filename: string): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const file = new File(Paths.cache, shareFilename(filename));
    file.write(new Uint8Array(Buffer.from(base64, "base64")));
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: filename });
    return true;
  } catch {
    return false;
  }
}
