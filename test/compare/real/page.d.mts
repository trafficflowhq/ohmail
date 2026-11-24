/** `page.mjs`: what runs inside the product's page and the reference's. */
export function markElement(args: [string | null, string]): boolean | "threw";
export function readElement(args: [string, "box" | "text" | "icon"]): Record<string, string | number | boolean | null> | null;
export function facesDeclared(): string[];
