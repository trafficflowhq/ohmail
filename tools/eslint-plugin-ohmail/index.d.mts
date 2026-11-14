import type { ESLint } from "eslint";

export interface Platform {
  id: string;
  packages?: string[];
  names?: string[];
}
export function isPlatformPackage(source: string, platforms: Platform[]): boolean;
export function isPlatformName(text: string, platforms: Platform[]): boolean;
export function isDoorFile(rel: string, doors: string[]): boolean;
export function readDoors(root: string): { doors: string[]; platforms: Platform[] };
/** tools/binders.json as the options of `ohmail/binder-callers`. */
export function readBinders(root: string): { names: string[]; files: string[] };
/** The session's marker's cookie name, as `ohmail/owner-lookup` looks for it. */
export const OWNER_MARKER_NAME: string;
declare const plugin: ESLint.Plugin;
export default plugin;
