/**
 * THE SWITCH'S PATHS, which the router is never handed. The link's one grammar is native's: `SwitchArrivals.take` and
 * `openSibling` in `modules/ohmail-switch/ios/OhmailSwitchModule.swift`; Android carries the payload as extras.
 * Imports nothing.
 */

/** The paths a switch link may take on any of the apps' domains: the released pair's and the preview pair's. */
export const SWITCH_PATHS: readonly string[] = ["/switch", "/switch-preview"];

/** Is this a path the switch's links take, whatever its host: the router is never handed one. */
export function isSwitchPath(path: string): boolean {
  const bare = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "").toLowerCase();
  return SWITCH_PATHS.some((p) => bare === p || bare.endsWith(p));
}
