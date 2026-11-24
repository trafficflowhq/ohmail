/** `registry.json` and `manifest.json`; the rules are stated in `registry.mjs`. */

export interface RegisteredState {
  /** The state's address query, parameters sorted. */
  key: string;
  screen: string;
  group: string;
  /** The state's name in its screen's own list; empty for a state listed beside the screens. */
  label: string;
  /** A screen's own state, one of its seven links, or a state listed beside the screens. */
  kind: "state" | "variant" | "also";
  /** Which of its screen's seven links this address is, when it is one. */
  link?: string;
  variant: { device: string; face: string; scheme: "light" | "dark" };
}

export interface Registry {
  studioTag: string;
  studioCommit: string;
  screens: { id: string; group: string; title: string }[];
  states: RegisteredState[];
}

/** One picture: where it is, what it weighs, and which state it was taken of. */
export interface ManifestRow {
  key: string;
  /** The shard (a screen's id) whose archive holds the picture and its data file. */
  shard: string;
  png: { sha256: string; bytes: number; w: number; h: number; scale: number };
  scene: { sha256: string };
  /** `stateHash` of the registered state at the time the picture was taken. */
  stateHash: string;
}

export interface Manifest {
  /** The tag each shard's pictures were taken at; a later tag moves only the shards it changed. */
  shards: Record<string, { studioTag: string; studioCommit: string }>;
  rows: ManifestRow[];
}

/** `archive.lock.json`: the pinned archive, one file a shard. */
export interface ArchiveLock {
  /** The shard every comparison run fetches and checks, whichever subjects exist. */
  canary: string;
  shards: { id: string; file: string; sha256: string; bytes: number; urls: string[] }[];
}

export const LINKS: string[];
export function keyOf(address: string): string;
export function fileOf(key: string): string;
export function stateHash(entry: RegisteredState): string;
export function deriveRegistry(source: unknown, at: { studioTag: string; studioCommit: string }): Registry;
export function registryText(registry: Registry): string;
