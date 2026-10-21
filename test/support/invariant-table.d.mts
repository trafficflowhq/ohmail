/** The invariant table's reader; the rules are stated in `invariant-table.mjs`. */

export const TABLE: string;
export const VERDICTS: string;
export const HEADER: string[];
export const STATUSES: string[];
export const WAITS: string[];
export function checkTable(root: string): string[];
