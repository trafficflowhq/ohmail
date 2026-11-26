import { useRef, useState } from "react";
import { useScreenerAcknowledgements } from "@ohmail/app-logic/consent";
import type { RefObject } from "react";
import type { TagEntity } from "@ohmail/wire";
import { Dialog, Menu, MenuItem, MenuRule } from "@ohmail/ui/base";
import { MovePicker } from "@ohmail/ui/mail";
import type { useResurfaceTime } from "../../frame/room.js";
import { TagPicker } from "../../tags/TagPicker.js";
import { useText } from "../../text/index.js";
import { isCardDeleteKey, type PanelMenu } from "../keys.js";
import { ResurfaceMenu } from "./ResurfaceMenu.js";
import type { ActionWords, OpenPanel, Placed } from "./panel-verbs.js";
import type { Verbs } from "./use-verbs.js";

function openScreening(root: HTMLElement | null, fallback?: () => void): void {
  const opener = root?.querySelector<HTMLButtonElement>('button[data-id="screening"]:not([hidden])');
  if (opener) opener.click();
  else fallback?.();
}

function menuAnchor(root: HTMLElement | null, which: PanelMenu): HTMLElement | null {
  const target = which === "resurface" || which === "tag" || which === "move" ? which : null;
  const own = target ? root?.querySelector<HTMLElement>(`[data-id="${target}"]:not([hidden])`) : null;
  return own ?? root?.querySelector<HTMLElement>("[data-more]") ?? null;
}

/** The reader panel's open menu and the control it opened from. */
export function useActionMenu(
  stop: RefObject<HTMLDivElement | null>,
  verbs: Verbs,
  onScreenKey?: () => void,
) {
  const [menu, setMenu] = useState<OpenPanel>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const acknowledgements = useScreenerAcknowledgements();
  const trashAcknowledged = acknowledgements.has("moveToTrash");
  const close = () => setMenu(null);
  const trash = () => {
    close();
    verbs.act("delete");
  };
  const confirmTrash = () => {
    acknowledgements.remember?.("moveToTrash");
    trash();
  };
  const toggle = (which: Exclude<OpenPanel, null>) => (at: HTMLElement) => {
    anchor.current = at;
    setMenu((open) => (open === which ? null : which));
  };
  const byKey = (which: PanelMenu) => {
    if (which === "cardDelete" && trashAcknowledged) return trash();
    if (which === "screening") return openScreening(stop.current, onScreenKey);
    anchor.current = menuAnchor(stop.current, which);
    setMenu((open) => (open === which ? null : which));
  };
  return { anchor, menu, setMenu, close, toggle, byKey, trash, confirmTrash, trashAcknowledged };
}

interface ActionMenusProps {
  words: ActionWords;
  anchor: RefObject<HTMLElement | null>;
  menu: OpenPanel;
  setMenu: (menu: OpenPanel) => void;
  close: () => void;
  trash: () => void;
  confirmTrash: () => void;
  hour: ReturnType<typeof useResurfaceTime>;
  tags: readonly TagEntity[];
  verbs: Verbs;
  behind: readonly Placed[];
  confirm: boolean;
  separate?: boolean;
  calendarAction?: { label: string; onPress: () => void };
  calendarKeyHint?: string;
}

export function ActionMenus({
  anchor,
  words,
  menu,
  setMenu,
  close,
  trash,
  confirmTrash,
  hour,
  tags,
  verbs,
  behind,
  confirm,
  separate = false,
  calendarAction,
  calendarKeyHint,
}: ActionMenusProps) {
  const t = useText("reader");
  const tp = useText("place");
  const more = menu === "more" || menu === "cardDelete";
  const draft = separate ? null : verbs.draft;
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
      {menu === "tag" && verbs.tag !== null ? (
        <TagPicker
          anchor={anchor}
          tags={tags}
          assigned={verbs.tagged}
          onToggle={(id, assigned) => {
            const tag = tags.find((tag) => tag.id === id);
            if (tag) verbs.tag?.(id, tag.name, assigned);
          }}
          onCreate={
            verbs.createTag === null
              ? undefined
              : (name) => {
                  close();
                  verbs.createTag?.(name);
                }
          }
          onClose={close}
        />
      ) : null}
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
          confirmTrash();
          return true;
        }}
      >
        {beforeRead.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={anchor} rule={false} />
        ))}
        {read.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={anchor} rule={false} />
        ))}
        {draft && (beforeRead.length > 0 || read.length > 0) ? <MenuRule /> : null}
        <DraftReplyItem draft={draft} close={close} words={words} />
        {separate && behind.length > 0 ? <MenuRule /> : null}
        <MenuItem icon="trash" keyHint="D" onPress={confirm ? () => setMenu("confirmDelete") : trash}>
          {words.delete}
        </MenuItem>
        {calendarAction ? (
          <CalendarItem action={calendarAction} close={close} keyHint={calendarKeyHint} />
        ) : null}
      </Menu>
      {confirm ? (
        <Dialog
          open={menu === "confirmDelete"}
          onClose={close}
          title={t("trashAsk")}
          hot
          kind="delete"
          confirm={{ label: words.move, onPress: confirmTrash, keyHint: "↵" }}
          cancel={{ label: t("resurface.cancel"), keyHint: "Esc" }}
        />
      ) : null}
    </>
  );
}

function CalendarItem({
  action,
  close,
  keyHint,
}: {
  action: NonNullable<ActionMenusProps["calendarAction"]>;
  close: () => void;
  keyHint?: string;
}) {
  return (
    <>
      <MenuRule />
      <MenuItem
        icon="calendar"
        keyHint={keyHint}
        onPress={() => {
          close();
          action.onPress();
        }}
      >
        {action.label}
      </MenuItem>
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
  rule,
}: {
  verb: Placed;
  close: () => void;
  more: RefObject<HTMLElement | null>;
  rule: boolean;
}) {
  return (
    <>
      {rule ? <MenuRule /> : null}
      <MenuItem
        icon={verb.icon}
        keyHint={verb.keyHint}
        label={verb.name}
        disabled={verb.disabled}
        description={verb.disabledHint}
        onPress={() => {
          const at = more.current;
          if (verb.id !== "resurface" && verb.id !== "tag" && verb.id !== "move") close();
          if (at !== null) verb.onPress?.(at);
        }}
      >
        {verb.label}
      </MenuItem>
    </>
  );
}
