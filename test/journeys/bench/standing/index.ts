import type { BenchId, Guard, Setting, Size } from "../seam.js";
import { MIRRORS } from "../../vocabulary/surfaces.js";
import { ANDROID } from "./android.js";
import { DESKTOP } from "./desktop.js";
import { AT_SIZE } from "./sizes.js";
import { STACK } from "./stack.js";

/** Each bench's standing list: the journeys of the setting it mirrors that it runs too. The web bench mirrors none. */
export const STANDING: Readonly<Record<BenchId, readonly string[]>> = { web: [], stack: STACK, desktop: DESKTOP, android: ANDROID };

/**
 * Does a journey run on this bench, in this setting, at this size? Where its guard names the setting; or
 * where the setting mirrors one the guard names and the bench's standing list holds its title. Below the
 * expanded size only the titles listed for that size run.
 */
export function runsOn(guard: Pick<Guard, "title" | "surfaces">, at: { id: BenchId; setting: Setting; size: Size }): boolean {
  if (at.size !== "expanded" && !AT_SIZE[at.size].includes(guard.title)) return false;
  if (guard.surfaces.includes(at.setting)) return true;
  const mirror = MIRRORS[at.setting];
  return mirror !== undefined && guard.surfaces.includes(mirror) && STANDING[at.id].includes(guard.title);
}
