/**
 * The diagnostic file's doors on a phone — the `*-native.ts` twin the node suite never imports.
 * The file goes into expo-sqlite's own directory, beside every mirror this app opens and under the
 * same backup exclusion, and the share sheet is the only way it leaves the phone: the person's
 * own act, to wherever they choose. Nothing here dials anything.
 */
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

import { buildCommit } from "../build-info";
import { secureKV } from "../state/servers-native";
import { recentEngineLines } from "./engine-log";
import { PHONE_DIAGNOSTIC_FILE_NAME, diagnosticFileUri, type PhoneDiagnosticDeps } from "./diagnostics";

/** The file, in the directory every mirror is opened in (`native.ts` passes no other). */
function diagnosticFile(): File {
  return new File(diagnosticFileUri(String(SQLite.defaultDatabaseDirectory), PHONE_DIAGNOSTIC_FILE_NAME));
}

export function nativePhoneDiagnosticDeps(): PhoneDiagnosticDeps {
  return {
    kv: secureKV(),
    now: () => new Date(),
    random16: () => Crypto.getRandomBytes(16),
    platform: { os: Platform.OS, osVersion: Platform.Version ?? null },
    build: { version: Constants.expoConfig?.version ?? null, commit: buildCommit(process.env.EXPO_PUBLIC_COMMIT) },
    lines: recentEngineLines,
    write: async (text) => {
      const file = diagnosticFile();
      file.write(text);
      return file.uri;
    },
  };
}

/** Raise the share sheet for the file just written. `false` = the platform refused. */
export async function shareDiagnosticFile(uri: string): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(uri, { mimeType: "application/json" });
    return true;
  } catch {
    return false;
  }
}
