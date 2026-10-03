/**
 * This phone's frame ceiling, read once per process from the posture module both platforms link:
 * Android's `ActivityManager.getMemoryClass` and `isLowRamDevice`, iOS's process memory limit
 * (`getProcessMemory`, mapped by `processMemoryHeap`). The `*-native.ts` twin the node suite never
 * imports; a binary without the readers, or one that throws, takes the floor (`frame-ceiling.ts`).
 */
import { requireOptionalNativeModule } from "expo";

import { deviceHeapOf, phoneFrameMaxChars, type HeapReaders } from "./frame-ceiling";

let ceiling: number | null = null;

export function phoneFrameCeiling(): number {
  if (ceiling === null) {
    let mod: HeapReaders | null = null;
    try {
      mod = requireOptionalNativeModule<HeapReaders>("OhmailPosture");
    } catch {
      mod = null;
    }
    ceiling = phoneFrameMaxChars(deviceHeapOf(mod));
  }
  return ceiling;
}
