"use client";

/**
 * The durable write door — one re-export; the door itself is in `@ohmail/client-engine`. It was
 * written here, and three published roots outside this app went on writing storage directly because
 * no package may import from an app: the engine's mirror registry, the UI package's theme provider,
 * and the desktop window. Moving it into the client's storage layer gives all four roots ONE latch,
 * one event name and one fault classification — the only thing a once-per-session notice can be
 * built on. This file stays so no import site moves, and holds no write of its own
 * (`test/durable-write-census.test.ts` asserts exactly that, in both directions).
 */

export {
  DURABILITY_LOST_EVENT,
  DurabilityLostEvent,
  dismissDurabilityLost,
  durabilityLost,
  durableProbe,
  durableRemove,
  durableSessionRemove,
  durableSessionSet,
  durableSet,
  localStorageDoor,
  resetDurabilityForTest,
  storageDoor,
} from "@ohmail/client-engine/durable";
export type { DurabilityLostDetail, DurableWrite, StorageDoor } from "@ohmail/client-engine/durable";
