/**
 * THE KEY SHEET'S ROWS, from one reading of the registry. One row per sentence: two chords that do the same thing
 * (`1` and `g o` both go to the Ohbox) are one instruction with two spellings. A row resting on every chord stands when there is
 * a reason to show. Columns: moving around; this message and the Screener; the app.
 */
import type { KeyHelpGroup, KeyHelpRow } from "@ohmail/ui/base";
import {
  chordKeys,
  groupedBindings,
  type BindingGroup,
  type BoundKey,
  type DisabledReason,
} from "@ohmail/app-logic/keys";
import type { Text } from "../../text/index.js";

const COLUMNS: readonly (readonly BindingGroup[])[] = [["navigate"], ["message", "screener"], ["app"]];

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
      row.chords.push(b.chord);
      row.live = row.live || b.disabled !== true;
      if (row.reason !== reason) row.reason = "";
    } else rows.push({ label: b.label, chords: [b.chord], live: b.disabled !== true, reason });
  }
  return rows
    .filter((r) => r.live || r.reason)
    .map((r) => ({
      label: r.label,
      keys: r.chords.map((c) => chordKeys(c, mod)),
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
  const grouped = groupedBindings([...bindings]);
  const groupOf = (group: BindingGroup): KeyHelpGroup | null => {
    const items = grouped.find((g) => g.group === group)?.items ?? [];
    const rows = foldRows(items, mod, reasons);
    return rows.length === 0 ? null : { title: words(`group.${group}`), rows };
  };
  return COLUMNS.map((column) => column.flatMap((group) => groupOf(group) ?? [])).filter(
    (column) => column.length > 0,
  );
}
