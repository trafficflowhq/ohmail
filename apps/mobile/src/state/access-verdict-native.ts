/**
 * The stored access verdicts, bound to the real keystore at import. The one module that ties
 * `state/access-verdict.ts` to expo-secure-store; the suite drives that module over a memory
 * `SecureKV` and never loads this file.
 */
import { bindAccessVerdicts } from "./access-verdict";
import { secureKV } from "./servers-native";

void bindAccessVerdicts(secureKV());
