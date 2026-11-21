import { useState } from "react";
import type { TagDTO } from "@ohmail/wire";
import { MOVE_TARGETS, type BulkAction } from "@ohmail/app-logic/press/actions";
import type { ListVerbs } from "@ohmail/app-logic/place-list";
import { Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { TagPicker } from "../tags/TagPicker.js";
import { useText } from "../text/index.js";
import { SelectionFoot } from "./SelectionFoot.js";
import type { RowSelection } from "./use-row-selection.js";

interface MailSelectionProps {
  selection: RowSelection;
  verbs?: ListVerbs;
  done?: boolean;
  moveToFolder?: (anchor: HTMLElement) => void;
}

export function MailSelectionFoot({ verbs, ...props }: MailSelectionProps) {
  return verbs && props.selection.ids.length > 0 ? <MailActions {...props} verbs={verbs} /> : null;
}

function MailActions({ selection, verbs, done, moveToFolder }: MailSelectionProps & { verbs: ListVerbs }) {
  const t = useText("ohbox");
  const places = useText("place");
  const { host } = useFrame();
  const [menu, setMenu] = useState<{ kind: "move" | "delete" | "tag"; anchor: HTMLElement } | null>(null);
  const { ids } = selection;
  const close = () => setMenu(null);
  const run = (action: BulkAction) => {
    close();
    if (verbs.bulkVerbs.run(action, ids)) selection.clear();
  };
  const action = (id: BulkAction, label: string, icon: PanelVerb["icon"]): PanelVerb => ({
    id,
    label,
    icon,
    onPress: () => run(id),
  });
  const ask = (kind: "move" | "tag" | "delete", label: string, icon: PanelVerb["icon"]): PanelVerb => ({
    id: kind,
    label,
    icon,
    onPress: (anchor) => setMenu({ kind, anchor }),
  });
  const items = [
    action("read", t("actionRead"), "read"),
    action("unread", t("pickedMarkUnseen"), "unread"),
    ...(done ? [action("done", t("actionDone"), "check")] : []),
    { ...ask("move", t("actionMove"), "move"), ...(moveToFolder ? { onPress: moveToFolder } : {}) },
    ask("tag", t("actionTag"), "tags"),
    action("later", t("actionLater"), "later"),
    ask("delete", t("actionDelete"), "trash"),
  ];
  const read = menu?.kind === "tag" ? host.engine.verbRead() : null;
  const tags = read?.list<TagDTO>("tag") ?? [];
  const assigned = tags
    .filter(({ id }) =>
      ids.every((messageId) => read?.get<{ labels: string[] }>("message", messageId)?.labels.includes(id)),
    )
    .map(({ id }) => id);
  return (
    <SelectionFoot selection={selection} verbs={items}>
      <Menu
        open={menu?.kind === "move"}
        onClose={close}
        anchor={menu?.anchor}
        up
        kind="card"
        label={t("moveLabel")}
      >
        {MOVE_TARGETS.map((to) => (
          <MenuItem key={to} onPress={() => run(`move:${to}`)}>
            {places(to)}
          </MenuItem>
        ))}
      </Menu>
      {menu?.kind === "tag" ? (
        <TagPicker
          anchor={menu.anchor}
          tags={tags}
          assigned={assigned}
          onToggle={(id, add) => verbs.bulkToggleTag(ids, id, add)}
          onClose={close}
        />
      ) : null}
      <Menu
        open={menu?.kind === "delete"}
        onClose={close}
        anchor={menu?.anchor}
        up
        kind="ask"
        label={t("bulkDeleteAsk", { count: ids.length })}
        title={t("bulkDeleteAsk", { count: ids.length })}
      >
        <MenuNote>{t("deleteNote")}</MenuNote>
        <MenuItem onPress={close}>{t("moveCancel")}</MenuItem>
        <MenuItem dot="hot" onPress={() => run("delete")}>
          {t("actionDelete")}
        </MenuItem>
      </Menu>
    </SelectionFoot>
  );
}
