export interface Finding {
  where: string;
  token: string;
  kind: "differs" | "product-only" | "sheet-only" | "stale-declared";
  product: string;
  sheet: string;
  declared: string;
}
export interface Declared {
  where: string;
  token: string;
  kind: string;
  reason: string;
  used: number;
}
/** One custom property of one rule. `media` is "" outside a media rule. */
export interface Declaration {
  media: string;
  selector: string;
  token: string;
  value: string;
}
export function same(product: unknown, sheet: unknown): boolean;
/** Every custom property a stylesheet declares, one entry per selector of its rule. */
export function declarations(css: string): Declaration[];
export function readDeclared(text: string): Declared[];
export function compare(inputs: {
  product: unknown;
  productIcons: unknown;
  productCss: Declaration[];
  declared: Declared[];
  sheet: unknown;
  sheetIcons: unknown;
  /** The sheet's stylesheets by file name. */
  sheetCss: Record<string, Declaration[]>;
}): { rows: Finding[]; compared: number; open: Finding[] };
export function compareDirs(dirs: { sheetDir?: string; productDir: string }): ReturnType<typeof compare>;
export function toTsv(rows: Finding[]): string;
/** The command: 0 nothing open, 1 a difference, 2 an input missing or unreadable. */
export function main(argv: string[]): number;
