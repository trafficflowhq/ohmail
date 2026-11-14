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
declare const plugin: ESLint.Plugin;
export default plugin;
