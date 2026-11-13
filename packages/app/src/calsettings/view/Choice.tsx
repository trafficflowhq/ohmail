/**
 * A SETTING CHOSEN FROM A SHORT LIST: the value as the line's slot, its menu of choices. Drawn only where the choice
 * can be saved; elsewhere the line says the value and offers nothing.
 */
import { useRef, useState } from "react";
import { Field, Menu, MenuItem, Slot } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";

export interface ChoiceItem {
  readonly key: string;
  readonly label: string;
}

export interface ChoiceProps {
  readonly label: string;
  /** What stands chosen; null while it has not been read. */
  readonly value: ChoiceItem | null;
  readonly items: readonly ChoiceItem[];
  /** Saves a choice; left out where it cannot be saved here. */
  readonly onPick?: (key: string) => void;
  /** A field over a long list that narrows it by its words, with what it is called. */
  readonly find?: { readonly label: string; readonly most: number };
}

export function Choice({ label, value, items, onPick, find }: ChoiceProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  if (onPick === undefined || value === null) return <SettingLine label={label} value={value?.label} />;
  const typed = words.trim().toLowerCase();
  const shown = find
    ? items.filter((item) => typed === "" || item.label.toLowerCase().includes(typed)).slice(0, find.most)
    : items;
  return (
    <SettingLine label={label}>
      <Slot ref={anchor} label={label} expanded={open} onPress={() => setOpen(true)}>
        {value.label}
      </Slot>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={label}
        kind={find ? "card" : undefined}
      >
        {find ? <Field label={find.label} value={words} onChange={setWords} bare sign="search" /> : null}
        {shown.map((item) => (
          <MenuItem
            key={item.key}
            checked={item.key === value.key}
            onPress={() => {
              setOpen(false);
              setWords("");
              if (item.key !== value.key) onPick(item.key);
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </SettingLine>
  );
}
