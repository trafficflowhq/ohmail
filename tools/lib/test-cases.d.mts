export const SEP: string;
export function isOldTestFile(rel: string): boolean;
export function splitKey(key: string): { path: string; name: string | null };
export function casesOf(text: string): { name: string; at: number; idle: string | null }[];
export function caseNamed(text: string, name: string): boolean;
