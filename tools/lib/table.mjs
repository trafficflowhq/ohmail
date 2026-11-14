// The package table of the written standard, checked against tools/borders.json: each row's
// "May import" cell is the border data written out in one fixed grammar.

const tick = (names) => names.map((name) => `\`${name}\``).join(", ");

/** The cell a row of tools/borders.json is written as. */
export function renderCell(row, kind) {
  if (kind === "app") {
    const parts = ["packages"];
    if (row.apps?.length) parts.push(`apps: ${tick(row.apps)}`);
    if (row.never?.length) parts.push(`never: ${tick(row.never)}`);
    return parts.join("; ");
  }
  const parts = [row.imports === "*" ? "anything" : row.imports.length ? tick(row.imports) : "nothing"];
  if (row.typesOnly?.length) parts.push(`types only: ${tick(row.typesOnly)}`);
  if (row.exportsNoValue) parts.push("exports no value");
  return parts.join("; ");
}

/** A cell as written, without its bold source marks. */
export const plainCell = (cell) =>
  cell
    .replace(/\*\*\[[^\]]*\]\*\*/g, "")
    .replaceAll("**", "")
    .replace(/\s+/g, " ")
    .trim();

export function tableBlock(markdown) {
  const begin = markdown.indexOf("<!-- package-table:begin");
  const end = markdown.indexOf("<!-- package-table:end -->");
  return begin >= 0 && end > begin ? markdown.slice(begin, end) : null;
}

/** @returns {Map<string, string>} folder → its "May import" cell, plain */
export function parseTable(block) {
  const lines = block.split("\n").filter((line) => line.startsWith("|"));
  const cells = (line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
  const column = cells(lines[0] ?? "").indexOf("May import");
  if (column < 0) throw new Error("the package table has no column named May import");
  const rows = new Map();
  for (const line of lines.slice(2)) {
    const row = cells(line);
    const folder = /^`((?:apps|packages)\/[a-z0-9-]+)`$/.exec(row[0])?.[1];
    if (!folder) throw new Error(`the package table's row "${row[0]}" does not begin with one folder`);
    rows.set(folder, plainCell(row[column]));
  }
  return rows;
}

/** @returns {string[]} what the table and the border data disagree on */
export function checkTable(borders, markdown, twin) {
  const block = tableBlock(markdown);
  if (!block) return ["table: the document has no package-table block"];
  const refusals = [];
  if (twin !== undefined && tableBlock(twin) !== block)
    refusals.push("table: the two documents' package-table blocks differ");
  const written = parseTable(block);
  const expected = new Map();
  for (const [key, row] of Object.entries(borders.packages))
    expected.set((row.folders ?? [`packages/${key}`])[0], renderCell(row, "package"));
  for (const [key, row] of Object.entries(borders.apps)) expected.set(`apps/${key}`, renderCell(row, "app"));
  for (const [folder, cell] of expected) {
    if (!written.has(folder))
      refusals.push(`table: ${folder} has a row in tools/borders.json and none in the table`);
    else if (written.get(folder) !== cell)
      refusals.push(`table: ${folder} reads "${written.get(folder)}", tools/borders.json says "${cell}"`);
  }
  for (const folder of written.keys()) {
    if (!expected.has(folder))
      refusals.push(`table: ${folder} has a row in the table and none in tools/borders.json`);
  }
  return refusals;
}
