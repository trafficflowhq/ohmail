import { useRef, useState } from "react";
import type { TagEntity as TagDTO } from "@ohmail/wire";
import { hueOf } from "@ohmail/app-logic/text/format";
import { design, Field, Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { newTagName } from "../settings/tags/model.js";
import { useText } from "../text/index.js";

const hues = design.tagHues as Readonly<Record<string, number>>;
const hueNames = Object.keys(hues);

export function TagPicker({
  anchor,
  tags,
  assigned,
  onToggle,
  onCreate,
  onClose,
}: {
  anchor: HTMLElement | null;
  tags: readonly TagDTO[];
  assigned: readonly string[];
  onToggle: (id: string, assigned: boolean) => void;
  onCreate?: (name: string) => void;
  onClose: () => void;
}) {
  const t = useText("tag");
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const draft = newTagName(tags, query);
  const shown = tags.filter(({ name }) => name.toLowerCase().includes(query.trim().toLowerCase()));
  const create = onCreate && draft && !draft.taken ? draft.name : null;
  const toggle = (id: string) => onToggle(id, !assigned.includes(id));

  return (
    <Menu
      open
      label={t("pickerAria")}
      anchor={anchor ?? undefined}
      up
      fit="beside"
      initialFocus={field}
      onClose={onClose}
    >
      <Field
        ref={field}
        row
        bare
        label={t("pickerPlaceholder")}
        placeholder={t("pickerPlaceholder")}
        value={query}
        onChange={setQuery}
        onEnter={() => {
          const first = shown[0];
          if (first) toggle(first.id);
          else if (create) onCreate?.(create);
        }}
      />
      {shown.map((tag) => (
        <MenuItem
          key={tag.id}
          checked={assigned.includes(tag.id)}
          many
          hue={hues[hueOf(tag, hueNames)] ?? 150}
          onPress={() => toggle(tag.id)}
        >
          {tag.name}
        </MenuItem>
      ))}
      {create ? (
        <MenuItem onPress={() => onCreate?.(create)}>{t("pickerCreate", { name: create })}</MenuItem>
      ) : shown.length === 0 ? (
        <MenuNote>{t("pickerNone")}</MenuNote>
      ) : null}
      <MenuNote>{t("notOnServer")}</MenuNote>
    </Menu>
  );
}
