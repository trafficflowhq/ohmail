/**
 * THE DRAWN DOCUMENT'S LENGTH CEILING IS THIS PHONE'S. The WebView copies the document into the app's
 * Java heap, so the longest document a phone can draw scales with its memory class: 50,000 characters
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

/**
 * The posture module's heap readers, any of which an older binary lacks: Android's memory class and
 * low-RAM flag, or iOS's process memory in bytes (`getProcessMemory`: available, footprint, physical).
 */
export interface HeapReaders {
  getMemoryClass?(): unknown;
  isLowRamDevice?(): unknown;
  getProcessMemory?(): unknown;
}

const MIB = 1024 * 1024;
/** MB of the process's memory limit per class MB, on iOS. */
export const IOS_LIMIT_MB_PER_CLASS_MB = 16;
/** A device with less physical memory than this (the 2 GB iPhones) is iOS's low-memory device. */
export const IOS_LOW_MEMORY_PHYSICAL_BYTES = 3 * 1024 * MIB;
/** The smallest class whose ceiling is the floor: an iPhone that is not low-memory never draws less. */
export const IOS_FLOOR_CLASS_MB = Math.ceil(PHONE_FRAME_FLOOR_CHARS / PHONE_FRAME_CHARS_PER_HEAP_MB);

/**
 * iOS's class from the process's memory LIMIT, which is fixed for the process: what it may still allocate
 * (`os_proc_available_memory`) plus what it holds (`phys_footprint`), / 16 MB. The momentary headroom alone
 * read low when mail was first opened under pressure. No limit (the simulator answers 0) is unknown. The
 * figure is the app process's; the WebView renders in its own process.
 */
export function processMemoryHeap(m: unknown): DeviceHeap | null {
  if (m === null || typeof m !== "object") return null;
  const { available, footprint, physical } = m as Record<string, unknown>;
  for (const v of [available, footprint, physical]) if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if ((available as number) <= 0 || (physical as number) <= 0) return null;
  const lowRam = (physical as number) < IOS_LOW_MEMORY_PHYSICAL_BYTES;
  const byLimit = ((available as number) + (footprint as number)) / MIB / IOS_LIMIT_MB_PER_CLASS_MB;
  return { memoryClassMb: lowRam ? byLimit : Math.max(byLimit, IOS_FLOOR_CLASS_MB), lowRam };
}

/** The heap the module reports, or null when it cannot say: absent, a reader missing or throwing, or an answer of the wrong kind. */
export function deviceHeapOf(mod: HeapReaders | null | undefined): DeviceHeap | null {
  if (mod == null) return null;
  if (typeof mod.getMemoryClass !== "function" || typeof mod.isLowRamDevice !== "function") {
    if (typeof mod.getProcessMemory !== "function") return null;
    try {
      return processMemoryHeap(mod.getProcessMemory());
    } catch {
      return null;
    }
  }
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

/** The longest document this phone's frame draws: min(8,000,000, 50,000 x class); the floor when unknown, at most the floor when low-RAM. */
export function phoneFrameMaxChars(heap: DeviceHeap | null): number {
  if (heap === null) return PHONE_FRAME_FLOOR_CHARS;
  const byClass = Math.min(PHONE_FRAME_MAX_CHARS, PHONE_FRAME_CHARS_PER_HEAP_MB * Math.floor(heap.memoryClassMb));
  return heap.lowRam ? Math.min(byClass, PHONE_FRAME_FLOOR_CHARS) : byClass;
}
