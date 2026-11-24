import type { Finding } from "./baseline.mjs";

export const CONFIG_COMMENT_RULE: string;
export function isSource(file: string): boolean;
export function linterConfig(root: string): string;
export function otherLinterConfigs(rootEntries: string[]): string[];
export function runEslint(
  root: string,
  files: string[],
  options?: { concurrency?: number | "off" | "auto" },
): Promise<(Finding & { line: number; message: string })[]>;
export function runStylelint(root: string, files: string[]): Promise<Finding[]>;
export function runPrettier(root: string, files: string[]): Promise<Finding[]>;
export function formatFiles(root: string, files: string[]): Promise<string[]>;
