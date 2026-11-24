import { useRef, useState } from "react";
import type { TagEntity as TagDTO } from "@ohmail/wire";
import { Field, Menu, MenuItem, MenuNote, type MenuProps } from "@ohmail/ui/base";
import { newTagName } from "../settings/tags/model.js";
import { useText } from "../text/index.js";
import { tagHue } from "./colours.js";

export function TagPicker({
  anchor,
  point,
  tags,
  assigned,
  onToggle,
  onCreate,
  onClose,
}: {
  anchor: MenuProps["returnFocus"] | null;
  point?: { x: number; y: number };
  tags: readonly TagDTO[];
  assigned: readonly string[];
  onToggle: (id: string, assigned: boolean) => void;
  onCreate?: (name: string) => void;
  onClose: () => void;
}) {
  const t = useText("tag");
  const field = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // The server collapses repeated whitespace before looking up the name.
  const draft = newTagName(tags, query.replace(/\s+/g, " "));
  const sought = draft?.name.toLowerCase() ?? "";
  const shown = tags.filter(({ name }) => name.toLowerCase().includes(sought));
  const create = onCreate && draft && !draft.taken ? draft.name : null;
  const toggle = (id: string) => onToggle(id, !assigned.includes(id));

  return (
    <Menu
      open
      label={t("pickerAria")}
      title={t("pickerTitle")}
      anchor={point ?? anchor ?? undefined}
      returnFocus={point ? (anchor ?? undefined) : undefined}
      up={!point}
      right={!point}
      fit="whole"
      initialFocus={field}
      initialFocusOnTouch={false}
      onKey={(e) => {
        if (e.target !== field.current) return false;
        if (e.nativeEvent.isComposing || e.key === "Home" || e.key === "End") return true;
        if (e.key !== "ArrowUp") return false;
        e.preventDefault();
        options.current?.querySelector<HTMLElement>('[role^="menuitem"]:last-child')?.focus();
        return true;
      }}
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
      <div ref={options} onFocus={(e) => (e.target as HTMLElement).scrollIntoView?.({ block: "nearest" })}>
        {shown.map((tag) => (
          <MenuItem
            key={tag.id}
            checked={assigned.includes(tag.id)}
            many
            hue={tagHue(tag.hue)}
            onPress={() => toggle(tag.id)}
          >
            {tag.name}
          </MenuItem>
        ))}
        {create ? (
          <MenuItem icon="plus" onPress={() => onCreate?.(create)}>
            {t("pickerCreate", { name: create })}
          </MenuItem>
        ) : tags.length === 0 && sought === "" ? (
          <MenuNote>{t("pickerNone")}</MenuNote>
        ) : null}
      </div>
    </Menu>
  );
}
