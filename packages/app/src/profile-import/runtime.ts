import type { ProfileImportPhase } from "./model.js";
import type { ProfileImportTransport } from "./wire.js";

export interface Mailbox {
  id: string;
  address: string;
  status?: string;
  legacyStandDown?: boolean;
}

export interface Runtime {
  owner: object | null;
  wire: ProfileImportTransport | null;
  roster: readonly Mailbox[] | null;
  mounted: boolean;
  phase: ProfileImportPhase;
}

export function currentOwner(runtime: Runtime, owner: object | null): boolean {
  return runtime.mounted && owner !== null && runtime.owner === owner;
}

export interface Timing {
  lastChecked: Map<string, number>;
  inFlight: Set<string>;
  rung: number | null;
  owed: Set<string>;
  answered: Map<string, number>;
}
