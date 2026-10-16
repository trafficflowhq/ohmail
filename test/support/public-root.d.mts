/** Where a published file sits in this checkout; the rule is stated in `public-root.mjs`. */

export const ROOT: string;
export const TEMPLATE: string;
export function publicRel(rel: string, root?: string): string;
export function publicPath(rel: string, root?: string): string;
export const PRIVATE_ROOTS: string[];
export function presentRoots(roots: readonly string[], root?: string): string[];
