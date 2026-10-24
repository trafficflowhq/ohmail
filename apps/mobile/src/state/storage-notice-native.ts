/**
 * The emptied-text notice's dismissals, bound to the real keystore at import. The suite drives
 * `state/storage-notice.ts` over a memory `SecureKV` and never loads this file.
 */
import { bindStorageNotices } from "./storage-notice";
import { secureKV } from "./servers-native";

void bindStorageNotices(secureKV());
