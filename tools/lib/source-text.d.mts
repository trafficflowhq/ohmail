export function readSource(text: string): { code: string; bare: string };
export function closeOf(code: string, open: number): number;
export function topLevelParts(code: string, from: number, to: number): [number, number][];
export type Entry =
  { key: string; value: string | null } | { spread: string; key?: undefined; value?: undefined };
export function entriesAt(
  reading: { code: string; bare?: string },
  text: string,
  brace: number,
): Entry[] | null;
export function literalInside(code: string, raw: string): string | null;
