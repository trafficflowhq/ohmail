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
/** A row of tools/shell-adapters.json: a file of the old shell's side of the frame, and the feeds it declares. */
export interface ShellAdapter {
  file: string;
  contexts?: string[];
}
export function readShellAdapters(root: string): { folder: string; files: ShellAdapter[] };
/** What a list of the old shell's files names that another did not: a file, or a context of a file it had. */
export function shellAdaptersAdded(now: ShellAdapter[], before: ShellAdapter[]): string[];
/** The session's marker's cookie name, as `ohmail/owner-lookup` looks for it. */
export const OWNER_MARKER_NAME: string;
declare const plugin: ESLint.Plugin;
export default plugin;
