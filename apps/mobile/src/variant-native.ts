/**
 * WHICH APP THIS IS: the identifier the system installed it under, read from the switch module at load and looked
 * up in the table (`variant.ts`). The `-native` twin the node suite never imports for its value. No setting decides
 * it: one JavaScript bundle runs in both apps, and each knows itself by its own identifier.
 */
import { requireOptionalNativeModule } from "expo";

import { appOfNative, type VariantRow } from "./variant";

export const APP: VariantRow = appOfNative(requireOptionalNativeModule<{ appId?: string }>("OhmailSwitch")?.appId ?? null);
