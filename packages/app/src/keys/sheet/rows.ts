/**
 * THE KEY SHEET'S ROWS, from one reading of the registry. One row per sentence: two chords that do the same thing
 * (`1` and `g o` both go to the Ohbox) are one instruction with two spellings. A row resting on every chord is left
 * out (the kit's sheet has no resting row yet). Columns: moving around; this message and the Screener; the app.
 */
import type { KeyHelpGroup, KeyHelpRow } from "@ohmail/ui/base";
import { chordKeys, groupedBindings, type BindingGroup, type BoundKey } from "@ohmail/app-logic/keys";
import type { Translator } from "@ohmail/app-logic/text";

const COLUMNS: readonly (readonly BindingGroup[])[] = [["navigate"], ["message", "screener"], ["app"]];

/** The bindings of one group, folded by their label; a row stands while one of its chords is live. */
export function foldRows(items: readonly BoundKey[], mod: string): KeyHelpRow[] {
  const rows: { label: string; chords: string[]; live: boolean }[] = [];
  for (const b of items) {
    const row = rows.find((r) => r.label === b.label);
    if (row) {
      row.chords.push(b.chord);
      row.live = row.live || b.disabled !== true;
    } else rows.push({ label: b.label, chords: [b.chord], live: b.disabled !== true });
  }
  return rows
    .filter((r) => r.live)
    .map((r) => ({ label: r.label, keys: r.chords.map((c) => chordKeys(c, mod)) }));
}

export function sheetColumns(
  bindings: readonly BoundKey[],
  mod: string,
  words: Translator,
): readonly (readonly KeyHelpGroup[])[] {
  const grouped = groupedBindings([...bindings]);
  const groupOf = (group: BindingGroup): KeyHelpGroup | null => {
    const items = grouped.find((g) => g.group === group)?.items ?? [];
    const rows = foldRows(items, mod);
    return rows.length === 0 ? null : { title: words(`group.${group}`), rows };
  };
  return COLUMNS.map((column) => column.flatMap((group) => groupOf(group) ?? [])).filter(
    (column) => column.length > 0,
  );
}
