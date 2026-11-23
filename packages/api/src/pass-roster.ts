import { passRosterFor, type PassRosterTable } from "@trafficflow/db/cloud";
import { doorDb } from "./context.js";
import type { ApiDeps } from "./deps.js";

export function rosterOf(deps: ApiDeps, table: PassRosterTable) {
  return passRosterFor(doorDb(deps), table);
}
