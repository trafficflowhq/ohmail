/**
 * THE DRAWN DOCUMENT'S LENGTH CEILING IS THIS PHONE'S. The WebView copies the document into the app's
 * Java heap, so the longest document a phone can draw scales with its memory class: 65,000 characters
 * per MB, never more than {@link PHONE_FRAME_MAX_CHARS}. A low-RAM phone is held to the floor, or to its
 * class's figure when that is lower. A phone whose class cannot be read (no posture module, a reader
 * missing or throwing, an answer that is not a positive number) is treated as a small one: the floor.
 */
import { PHONE_FRAME_CHARS_PER_HEAP_MB, PHONE_FRAME_FLOOR_CHARS, PHONE_FRAME_MAX_CHARS } from "./frame-budget";

/** What the posture module says about the app's heap: `getMemoryClass` in MB, `isLowRamDevice`. */
export interface DeviceHeap {
  readonly memoryClassMb: number;
  readonly lowRam: boolean;
}

/** The posture module's two heap readers, either of which an older binary lacks. */
export interface HeapReaders {
  getMemoryClass?(): unknown;
  isLowRamDevice?(): unknown;
}

/** The heap the module reports, or null when it cannot say: absent, a reader missing or throwing, or an answer of the wrong kind. */
export function deviceHeapOf(mod: HeapReaders | null | undefined): DeviceHeap | null {
  if (mod == null || typeof mod.getMemoryClass !== "function" || typeof mod.isLowRamDevice !== "function") return null;
  try {
    const memoryClassMb = mod.getMemoryClass();
    const lowRam = mod.isLowRamDevice();
    if (typeof memoryClassMb !== "number" || !Number.isFinite(memoryClassMb) || memoryClassMb < 1) return null;
    if (typeof lowRam !== "boolean") return null;
    return { memoryClassMb, lowRam };
  } catch {
    return null;
  }
}

/** The longest document this phone's frame draws: min(8,000,000, 65,000 x class); the floor when unknown, at most the floor when low-RAM. */
export function phoneFrameMaxChars(heap: DeviceHeap | null): number {
  if (heap === null) return PHONE_FRAME_FLOOR_CHARS;
  const byClass = Math.min(PHONE_FRAME_MAX_CHARS, PHONE_FRAME_CHARS_PER_HEAP_MB * Math.floor(heap.memoryClassMb));
  return heap.lowRam ? Math.min(byClass, PHONE_FRAME_FLOOR_CHARS) : byClass;
}
