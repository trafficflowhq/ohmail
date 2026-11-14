export interface Borders {
  packages: Record<
    string,
    { imports: string[] | "*"; typesOnly?: string[]; exportsNoValue?: boolean; folders?: string[] }
  >;
  apps: Record<string, { never?: string[]; apps?: string[] }>;
  tests?: { alsoImport?: string[] };
  roots?: { folders?: string[] };
}
export function renderCell(
  row: Borders["packages"][string] | Borders["apps"][string],
  kind: "package" | "app",
): string;
export function plainCell(cell: string): string;
export function tableBlock(markdown: string): string | null;
export function parseTable(block: string): Map<string, string>;
export function checkTable(borders: Borders, markdown: string, twin?: string): string[];
