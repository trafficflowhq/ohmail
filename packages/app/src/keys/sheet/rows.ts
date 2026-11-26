/**
 * THE KEY SHEET'S ROWS, from one reading of the registry. One row per sentence: two chords that do the same thing
 * (`1` and `g o` both go to the Ohbox) are one instruction with two spellings. A row with no usable chord remains listed as unavailable. Columns: moving around; this message and the Screener; the app.
 */
import type { KeyHelpGroup, KeyHelpRow } from "@ohmail/ui/base";
import {
  chordKeys,
  groupedBindings,
  type BindingGroup,
  type BoundKey,
  type DisabledReason,
  type ShortcutPlace,
} from "@ohmail/app-logic/keys";
import type { Text } from "../../text/index.js";

type Section = BindingGroup | ShortcutPlace;
const COLUMNS: readonly (readonly Section[])[] = [
  ["lists", "navigate", "screener"],
  ["message", "composer"],
  ["calendar", "app"],
];

/** Fold spellings by label. A disabled reason belongs to the whole row only when every spelling gives it. */
export function foldRows(
  items: readonly BoundKey[],
  mod: string,
  reasons: Partial<Record<DisabledReason, string>> = {},
): KeyHelpRow[] {
  const rows: { label: string; chords: string[]; live: boolean; reason: string }[] = [];
  for (const b of items) {
    const reason = b.disabled && b.disabledReason ? (reasons[b.disabledReason] ?? "") : "";
    const row = rows.find((r) => r.label === b.label);
    if (row) {
      if (!row.chords.includes(b.chord)) row.chords.push(b.chord);
      row.live = row.live || b.disabled !== true;
      if (row.reason !== reason) row.reason = "";
    } else rows.push({ label: b.label, chords: [b.chord], live: b.disabled !== true, reason });
  }
  return rows.map((r) => ({
    label: r.label,
    keys: r.chords.map((c) => chordKeys(c, mod)),
    ...(!r.live ? { disabled: true } : {}),
    ...(r.reason ? { disabledReason: r.reason } : {}),
  }));
}

export function sheetColumns(
  bindings: readonly BoundKey[],
  mod: string,
  words: Text,
  trash: Text,
): readonly (readonly KeyHelpGroup[])[] {
  const reasons: Record<DisabledReason, string> = {
    no_cursor: words("needsCursor"),
    no_erase: trash.has("noErase") ? trash("noErase") : "",
    restore_only: trash.has("restoreKey") ? trash("restoreKey") : "",
    trash_unavailable: trash.has("unavailable") ? trash("unavailable") : "",
    layout_same: words.has("layoutSame") ? words("layoutSame") : "",
  };
  // Alt chords can collide with AltGr characters on international layouts.
  const offered = bindings.filter(({ chord }) => !chord.toLowerCase().split(/[ +]/).includes("alt"));
  const live = groupedBindings(offered.filter((binding) => !binding.helpOnly)).flatMap(({ items }) => items);
  const actions = new Map<string, { section: Section; keys: BoundKey[] }>();
  for (const binding of [...live, ...offered.filter((binding) => binding.helpOnly)]) {
    const row = actions.get(binding.label);
    if (!row) actions.set(binding.label, { section: binding.place ?? binding.group, keys: [binding] });
    else {
      if (binding.place && row.section === "navigate") row.section = binding.place;
      if (!row.keys.some((key) => key.chord === binding.chord)) row.keys.push(binding);
    }
  }
  const groupOf = (group: Section): KeyHelpGroup | null => {
    const items = [...actions.values()].flatMap(({ section, keys }) => (section === group ? keys : []));
    const rows = foldRows(items, mod, reasons);
    return rows.length === 0 ? null : { title: words(`group.${group}`), rows };
  };
  return COLUMNS.map((column) => column.flatMap((group) => groupOf(group) ?? [])).filter(
    (column) => column.length > 0,
  );
}
