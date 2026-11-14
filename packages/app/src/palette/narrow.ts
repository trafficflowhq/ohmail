/** Word by word: every word typed is in the label, in any order ("go ohbox" finds "Go to the Ohbox"). */
export function narrow<T extends { readonly label: string }>(
  rows: readonly T[],
  query: string,
): readonly T[] {
  const words = query
    .toLowerCase()
    .split(" ")
    .filter((word) => word !== "");
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const label = row.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}
