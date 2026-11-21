import { useState } from "react";
import { Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";

export function ReadActionPanel({
  items,
  duplicate,
  blocked,
  more,
  setMore,
  duplicatePrimary,
  retry,
  behind,
  note,
  edit,
}: {
  items: readonly PanelVerb[];
  duplicate?: () => void;
  blocked: boolean;
  more: HTMLElement | null;
  setMore: (anchor: HTMLElement | null) => void;
  duplicatePrimary: boolean;
  retry?: PanelVerb;
  behind: readonly PanelVerb[];
  note?: string;
  edit?: () => void;
}) {
  const t = useText("calendar");
  const [folded, setFolded] = useState<readonly string[]>([]);
  const readItems: PanelVerb[] = [
    ...(retry ? [{ ...retry, disabled: blocked || retry.disabled }] : []),
    ...(edit
      ? [
          {
            id: "edit",
            label: t("edit.action"),
            icon: "write" as const,
            keyHint: "e",
            shortcut: "e",
            rank: 0,
            disabled: blocked,
            onPress: edit,
          },
        ]
      : []),
    ...(duplicate
      ? [
          {
            id: "duplicate",
            label: t("edit.duplicate"),
            icon: "copy" as const,
            shortcut: "Shift+D",
            keyHint: "⇧d",
            kind: duplicatePrimary ? ("ink" as const) : undefined,
            rank: duplicatePrimary ? 0 : 1,
            disabled: blocked,
            onPress: duplicate,
          },
        ]
      : []),
    ...items,
  ];
  const panel =
    readItems.length || behind.length || note ? (
      <ActionPanel
        label={t("actions.panel")}
        items={readItems}
        onFold={setFolded}
        folded={folded}
        more={{
          label: t("more"),
          behind: behind.length > 0 || !!note,
          expanded: more !== null,
          onPress: setMore,
        }}
      />
    ) : null;
  const overflow = more && (
    <Menu open anchor={more} label={t("more")} onClose={() => setMore(null)}>
      {note && <MenuNote>{note}</MenuNote>}
      {[...readItems.filter((item) => folded.includes(item.id)), ...behind].map((item) => (
        <MenuItem
          key={item.id}
          icon={item.icon}
          disabled={blocked || item.disabled}
          onPress={() => {
            setMore(null);
            item.onPress?.(more);
          }}
        >
          {item.label}
        </MenuItem>
      ))}
    </Menu>
  );

  return (
    <>
      {panel}
      {overflow}
    </>
  );
}
