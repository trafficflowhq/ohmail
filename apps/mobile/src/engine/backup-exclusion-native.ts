/**
 * The backup module's one door — the `*-native.ts` twin the node suite never imports (importing
 * `expo` pulls the whole Expo runtime, which needs `__DEV__` and is absent under vitest; every
 * rule is driven through `backup-exclusion.ts` instead). `requireOptionalNativeModule` answers
 * `null` where the native half is absent — an old build, a client without it — and `null` is what
 * keeps the state `unknown` rather than inventing an answer. A bare `require` of a missing native
 * module is fatal and no `catch` around it can fire, which is why the presence question is asked
 * this way and not that one.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import {
  measureBackupExclusion,
  recordBackupExclusion,
  type BackupExclusionNative,
} from "./backup-exclusion";
import { logBackupExclusion } from "./engine-log";

export function nativeBackupExclusion(): BackupExclusionNative | null {
  return requireOptionalNativeModule<BackupExclusionNative>("OhmailBackupExclusion");
}

/**
 * Called once per mirror open, with the path expo-sqlite actually opened. Never throws and never
 * delays the open's outcome by more than the two native calls: a mailbox does not wait on a
 * claim about backups, and a measurement that failed is reported as unmeasured.
 */
export async function settleBackupExclusion(databasePath: string | undefined): Promise<void> {
  const state = await measureBackupExclusion(nativeBackupExclusion(), databasePath);
  recordBackupExclusion(state);
  logBackupExclusion(state, Platform.OS);
}
