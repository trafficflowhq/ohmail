import type { RefObject } from "react";
import type { TagEntity } from "@ohmail/wire";
import { Dialog, Menu, MenuItem } from "@ohmail/ui/base";
import { MovePicker } from "@ohmail/ui/mail";
import type { useResurfaceTime } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { isCardDeleteKey } from "../keys.js";
import { ResurfaceMenu } from "./ResurfaceMenu.js";
import type { ActionWords, OpenPanel, Placed } from "./panel-verbs.js";
import type { Verbs } from "./use-verbs.js";

interface ActionMenusProps {
  words: ActionWords;
  anchor: RefObject<HTMLElement | null>;
  menu: OpenPanel;
  setMenu: (menu: OpenPanel) => void;
  close: () => void;
  trash: () => void;
  hour: ReturnType<typeof useResurfaceTime>;
  tags: readonly TagEntity[];
  verbs: Verbs;
  behind: readonly Placed[];
  confirm: boolean;
}

export function ActionMenus({
  anchor,
  words,
  menu,
  setMenu,
  close,
  trash,
  hour,
  tags,
  verbs,
  behind,
  confirm,
}: ActionMenusProps) {
  const t = useText("reader");
  const tp = useText("place");
  const more = menu === "more" || menu === "cardDelete";
  const beforeRead = behind.filter((verb) => verb.id !== "read");
  const read = behind.filter((verb) => verb.id === "read");
  return (
    <>
      <ResurfaceMenu
        open={menu === "resurface"}
        onClose={close}
        anchor={anchor}
        act={verbs.act}
        stored={hour.stored}
        store={hour.store}
      />
      <Menu open={menu === "tag"} onClose={close} anchor={anchor} label={words.tag} up right>
        {tags.map((tag) => {
          const on = verbs.tagged.includes(tag.id);
          return (
            <MenuItem key={tag.id} checked={on} onPress={() => verbs.tag?.(tag.id, tag.name, !on)}>
              {tag.name}
            </MenuItem>
          );
        })}
      </Menu>
      <MovePicker
        open={menu === "move"}
        onClose={close}
        anchor={anchor}
        label={words.move}
        title={words.move}
        places={verbs.moves.map((id) => ({ id, label: tp(id) }))}
        folders={[]}
        onMove={(id) => {
          close();
          verbs.act(`move:${id as (typeof verbs.moves)[number]}`);
        }}
      />
      <Menu
        open={more}
        onClose={close}
        anchor={anchor}
        label={words.more}
        up
        right
        onKey={(e) => {
          if (menu !== "cardDelete" || !isCardDeleteKey(e.nativeEvent)) return false;
          e.preventDefault();
          trash();
          return true;
        }}
      >
        {beforeRead.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={anchor} />
        ))}
        {verbs.moves.length > 0 ? (
          <MenuItem icon="move" onPress={() => setMenu("move")}>
            {words.move}
          </MenuItem>
        ) : null}
        {read.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={anchor} />
        ))}
        <DraftReplyItem draft={verbs.draft} close={close} words={words} />
        <MenuItem icon="trash" onPress={confirm ? () => setMenu("confirmDelete") : trash}>
          {words.delete}
        </MenuItem>
      </Menu>
      {confirm ? (
        <Dialog
          open={menu === "confirmDelete"}
          onClose={close}
          title={t("trashAsk")}
          hot
          kind="delete"
          confirm={{ label: words.move, onPress: trash, keyHint: "↵" }}
          cancel={{ label: t("resurface.cancel"), keyHint: "Esc" }}
        />
      ) : null}
    </>
  );
}

function DraftReplyItem({
  draft,
  close,
  words,
}: {
  draft: (() => void) | null;
  close: () => void;
  words: ActionWords;
}) {
  if (draft === null) return null;
  return (
    <MenuItem
      icon="spark"
      onPress={() => {
        close();
        draft();
      }}
    >
      {words.draftReply}
    </MenuItem>
  );
}

/**
 * A verb behind More. Resurface and Tag open their own menus in More's place, out of More's button: the press hands
 * the element More was pressed on.
 */
function BehindMore({
  verb,
  close,
  more,
}: {
  verb: Placed;
  close: () => void;
  more: RefObject<HTMLElement | null>;
}) {
  return (
    <MenuItem
      icon={verb.icon}
      onPress={() => {
        const at = more.current;
        if (verb.id !== "resurface" && verb.id !== "tag") close();
        if (at !== null) verb.onPress?.(at);
      }}
    >
      {verb.label}
    </MenuItem>
  );
}
