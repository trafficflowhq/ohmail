/**
 * IS THIS MACHINE ON POWER — asked by a store-only pass before each round. Read by the engine from
 * the files Linux keeps under `/sys/class/power_supply`; no process is spawned. A laptop on battery
 * runs no round. A machine without a system battery reads as on power, and so does a host this
 * reading cannot answer (macOS, Windows, a sandbox that hides the directory): the pass is bounded
 * and runs once per install, so a wrong "on power" costs minutes of one core, while a wrong
 * "battery" is an index that never finishes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const POWER_SUPPLY_DIR = "/sys/class/power_supply";
export type HostPowerState = "ac" | "battery" | "no-battery" | "unknown";

/** How long one reading is reused; the pass asks at most once per tick. */
export const HOST_POWER_READ_EVERY_MS = 60_000;

export interface PowerVerdict {
  onPower: boolean;
  state: HostPowerState;
}

const read = (dir: string, name: string): string | null => {
  try { return readFileSync(join(dir, name), "utf8").trim(); } catch { return null; }
};

/** One reading of a power-supply directory laid out as Linux lays it out. */
export function readPowerSupplies(root: string = POWER_SUPPLY_DIR): HostPowerState {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return "unknown"; }
  const mains: boolean[] = [];
  const batteries: string[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    const type = read(dir, "type");
    if (type === "Mains" || type === "USB") mains.push(read(dir, "online") === "1");
    // `scope=Device` is a mouse's or a headset's own battery, not the machine's.
    else if (type === "Battery" && read(dir, "scope") !== "Device") batteries.push(read(dir, "status") ?? "Unknown");
  }
  if (batteries.length === 0) return "no-battery";
  if (mains.some((online) => online)) return "ac";
  if (batteries.some((s) => s === "Discharging") || mains.length > 0) return "battery";
  return "ac";
}

export function powerVerdictOf(state: HostPowerState): PowerVerdict {
  return { onPower: state !== "battery", state };
}

/** The verdict, re-read at most every {@link HOST_POWER_READ_EVERY_MS}. */
export function createHostPower(opts: {
  now?: () => number;
  readState?: () => HostPowerState;
} = {}): () => PowerVerdict {
  const now = opts.now ?? Date.now;
  const readState = opts.readState
    ?? (() => (process.platform === "linux" ? readPowerSupplies() : "unknown"));
  let last: { state: HostPowerState; at: number } | null = null;
  return () => {
    if (last === null || now() - last.at >= HOST_POWER_READ_EVERY_MS) last = { state: readState(), at: now() };
    return powerVerdictOf(last.state);
  };
}
