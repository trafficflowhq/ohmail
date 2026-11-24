/**
 * A ROW'S MENU, at the point a right click, the menu key or a long press names: the row's own verbs on the letter it
 * opens on, in the order the design draws them, each with its key. Every verb is the model's.
 */
import type { OhboxRow } from "@ohmail/client-engine";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import { Menu, MenuItem, MenuRule } from "@ohmail/ui/base";
import type { RowAsk } from "@ohmail/app-logic/ohbox";
import { useText } from "../text/index.js";

export function OhboxRowMenu({
  model,
  row,
  at,
  anchor,
  onClose,
  onScreen,
  onAsk,
  canDelete,
}: {
  model: OhboxListModel;
  row: OhboxRow;
  at: { x: number; y: number };
  anchor: HTMLElement;
  onClose: () => void;
  onScreen?: () => void;
  onAsk?: (ask: RowAsk) => void;
  canDelete: boolean;
}) {
  const t = useText("ohbox");
  const screening = useText("screening");
  const picked = row.members.every((m) => model.picked.has(m.id));
  const run = (verb: () => void) => () => {
    onClose();
    verb();
  };
  const act = (action: MessageAction) => run(() => model.actOn(row, action));
  const ask = (kind: RowAsk["kind"]) =>
    run(() => onAsk?.({ kind, letter: row.openTarget, act: (action) => model.actOn(row, action, "letter") }));
  return (
    <Menu open onClose={onClose} anchor={at} kind="context" label={t("row.menu")}>
      <MenuItem icon="mail" keyHint="↵" onPress={run(() => model.open(row.openTarget))}>
        {t("row.open")}
      </MenuItem>
      <MenuRule />
      <MenuItem icon="reply" keyHint="r" onPress={act("reply")}>
        {t("actionReply")}
      </MenuItem>
      <MenuItem icon="forward" keyHint="⇧F" onPress={act("forward")}>
        {t("row.forward")}
      </MenuItem>
      <MenuRule />
      <MenuItem icon="later" keyHint="a" onPress={act("later")}>
        {t("actionLater")}
      </MenuItem>
      <MenuItem icon="parked" keyHint="e" onPress={act("aside")}>
        {t("actionSetAside")}
      </MenuItem>
      <MenuItem icon="resurface" keyHint="b" onPress={act("resurface")}>
        {t("actionResurface")}
      </MenuItem>
      <MenuRule />
      <MenuItem icon="tags" keyHint="t" onPress={run(() => model.tagRow(row, anchor, at))}>
        {t("actionTag")}
      </MenuItem>
      {onScreen ? (
        <MenuItem icon="screener" keyHint="s" onPress={run(onScreen)}>
          {screening("action")}
        </MenuItem>
      ) : null}
      {onAsk ? (
        <MenuItem icon="move" keyHint="m" onPress={ask("move")}>
          {t("actionMove")}
        </MenuItem>
      ) : null}
      <MenuRule />
      {model.doneOffered(row) ? (
        <MenuItem icon="check" keyHint="⇧I" onPress={run(() => model.doneRow(row))}>
          {t("actionDone")}
        </MenuItem>
      ) : (
        <MenuItem icon="unread" keyHint="u" onPress={run(() => model.markUnread(row.openTarget))}>
          {t("actionMarkUnread")}
        </MenuItem>
      )}
      <MenuItem icon="pick" keyHint="x" onPress={run(() => model.togglePick(row.openTarget.id))}>
        {picked ? t("row.deselect") : t("row.select")}
      </MenuItem>
      {onAsk && canDelete ? (
        <>
          <MenuRule />
          <MenuItem icon="trash" keyHint="d" onPress={ask("delete")}>
            {t("actionDelete")}
          </MenuItem>
        </>
      ) : null}
    </Menu>
  );
}
