import type { Borders } from "../lib/table.mjs";

export interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
export interface Workspace {
  root: string;
  borders: Borders;
}
export function unitFolder(rel: string): string | null;
export function isTestFile(rel: string): boolean;
export function isToolingFile(rel: string): boolean;
export function packageNameOf(source: string): string;
/** `given.manifests` is keyed by folder; `"."` is the root's. */
export function loadWorkspace(
  root: string,
  given?: { borders?: Borders; manifests?: Record<string, Manifest> },
): Workspace;
export function borderVerdict(
  workspace: Workspace,
  file: string,
  source: string,
  how: { typeOnly: boolean },
): string | null;
export function borderRefusal(
  workspace: Workspace,
  file: string,
  source: string,
  how: { typeOnly: boolean },
): { why: string; reach: string } | null;
export function declaredVerdict(
  workspace: Workspace,
  file: string,
  source: string,
  how: { typeOnly: boolean },
): string | null;
