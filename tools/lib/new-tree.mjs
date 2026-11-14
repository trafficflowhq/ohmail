// tools/new-tree.txt: the folders and files the formatter and the new-tree rules bind. The old
// tree is not on it, so neither a run nor an editor reformats it.

/** @returns {string[]} the listed paths; throws when the list is empty */
export function parseNewTree(text) {
  const entries = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (entries.length === 0)
    throw new Error("tools/new-tree.txt is missing or empty: the formatter would check nothing");
  return entries;
}

export const inNewTree = (rel, entries) =>
  entries.some((entry) => rel === entry || rel.startsWith(`${entry}/`));

/** .prettierignore, written from the list: everything is ignored, then each listed path is let in. */
export function renderPrettierIgnore(entries) {
  const lines = [
    "# Written from tools/new-tree.txt by `node tools/check.mjs --write-prettierignore`. Do not edit.",
    "/*",
  ];
  const opened = new Set();
  for (const entry of entries) {
    const parts = entry.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      if (!opened.has(parent)) lines.push(`!/${parent}`, `/${parent}/*`);
      opened.add(parent);
    }
    lines.push(`!/${entry}`);
  }
  // The planted violations are fixtures: they are wrong on purpose.
  lines.push("/tools/plant");
  return lines.join("\n") + "\n";
}
