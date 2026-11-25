import { useScreenerAcknowledgements } from "@ohmail/app-logic/consent";
import { Fragment, useContext, useState } from "react";
import type { EngineMessage, TagEntity } from "@ohmail/wire";
import type { ListVerbs } from "@ohmail/app-logic/place-list";
import type { MessageAction, MoveTarget } from "@ohmail/app-logic/press/actions";
import { moveTargetsOf, readIsItsRelease } from "@ohmail/app-logic/reader";
import { Dialog, type IconName } from "@ohmail/ui/base";
import { MovePicker, Row, type RowProps } from "@ohmail/ui/mail";
import { FrameContext } from "../frame/commands.js";
import { MailRowMenu, type ContextItem, type MenuTarget } from "../frame/ContextMenu.js";
import { TagPicker } from "../tags/TagPicker.js";
import { useOwnAddresses } from "../frame/room.js";
import { hasReplyAll } from "../reader/actions/use-verbs.js";
import { useText } from "../text/index.js";
import type { ListMenuItem } from "./ListMenu.js";

export { MailRowMenu, type MenuTarget } from "../frame/ContextMenu.js";

const LETTER_ACTIONS = [
  ["open", "row.open", "mail", "↵", 0],
  ["reply", "actionReply", "reply", "r", 1],
  ["replyAll", "actionReplyAll", "replyall", undefined, 1],
  ["forward", "row.forward", "forward", "⇧F", 1],
  ["later", "actionLater", "later", "a", 2],
  ["park", "actionSetAside", "parked", "e", 2],
  ["resurface", "actionResurface", "resurface", "b", 2],
  ["tag", "actionTag", "tags", "t", 3],
  ["screen", "action", "screener", "s", 3],
  ["move", "actionMove", "move", "m", 3],
  ["done", "actionDone", "check", "⇧I", 4],
  ["read", "verb.markRead", "read", "u", 4],
  ["unread", "actionMarkUnread", "unread", "u", 4],
  ["select", "row.select", "pick", "x", 4],
  ["deselect", "row.deselect", "pick", "x", 4],
  ["delete", "actionDelete", "trash", "d", 5],
] as const satisfies readonly [string, string, IconName, string | undefined, number][];

type LetterAction = (typeof LETTER_ACTIONS)[number][0];
type LetterMenuActions = Partial<
  Record<LetterAction, (() => void) | Pick<ContextItem, "onPress" | "keepOpen">>
>;

/** A shared order and wording, with only the actions the place handed. */
export function useMailRowItems(
  actions: LetterMenuActions,
  keys = false,
  extras: readonly ContextItem[] = [],
) {
  const t = useText("ohbox");
  const screening = useText("screening");
  const reader = useText("reader");
  let group = 0;
  const items: ContextItem[] = [];
  for (const [id, word, icon, keyHint, nextGroup] of LETTER_ACTIONS) {
    const action = actions[id];
    if (action) {
      items.push({
        label: (id === "screen" ? screening : id === "read" ? reader : t)(word),
        icon,
        keyHint: keys ? keyHint : undefined,
        apart: nextGroup !== group,
        ...(typeof action === "function" ? { onPress: action } : action),
      });
      group = nextGroup;
    }
    if (id === "open") items.push(...extras);
  }
  return items;
}

interface RowMenuActions {
  message: EngineMessage;
  verbs?: ListVerbs;
  markUnread?: () => void;
  screen?: (anchor: HTMLElement) => void;
  folderMove?: boolean;
}

/** The callbacks belong to the place. This component adds a door to them on its row. */
export function MailRow({
  actions,
  menuItems,
  ...props
}: RowProps & {
  actions?: RowMenuActions;
  menuItems?: (target: MenuTarget) => readonly ListMenuItem[];
}) {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const hasMenu = Boolean(props.onOpen || menuItems || actions);
  return (
    <>
      <Row
        {...props}
        onMenu={
          props.onMenu ??
          (hasMenu
            ? (at, row) => {
                const anchor = row.querySelector<HTMLElement>(".oh-row") ?? row;
                setTarget({ at, anchor });
              }
            : undefined)
        }
      />
      {target?.anchor.isConnected ? (
        <LetterRowMenu
          target={target}
          actions={actions}
          items={menuItems?.(target) ?? []}
          open={props.onOpen}
          picked={props.picked}
          pick={props.selection}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}

function LetterRowMenu({
  target,
  actions,
  items,
  open,
  picked,
  pick,
  onClose,
}: {
  target: MenuTarget;
  actions?: RowMenuActions;
  items: readonly ContextItem[];
  open?: () => void;
  picked?: boolean;
  pick?: RowProps["selection"];
  onClose: () => void;
}) {
  const own = useOwnAddresses();
  const host = useContext(FrameContext)?.api.host;
  const trashAcknowledged = useScreenerAcknowledgements().has("moveToTrash");
  const [ask, setAsk] = useState<"tag" | "move" | "delete" | null>(null);
  const { message, verbs, markUnread, screen, folderMove } = actions ?? {};
  const act = (action: MessageAction) => () => {
    if (message) verbs?.onMessageAction(action, message);
  };
  const read =
    verbs && message
      ? () => {
          verbs.bulkVerbs.run("read", [message.id]);
        }
      : undefined;
  const unread =
    markUnread ??
    (verbs && message
      ? () => {
          verbs.bulkVerbs.run("unread", [message.id]);
        }
      : undefined);
  const readState = message?.unread ? read : unread;
  const moves = verbs && message && !folderMove ? moveTargetsOf(message) : [];
  const readCurrent = () => host?.engine.verbRead();
  const canDelete = verbs && message && readCurrent()?.get<EngineMessage>("message", message.id) != null;
  const rowItems = useMailRowItems(
    {
      open,
      ...(verbs && message
        ? {
            reply: act("reply"),
            replyAll: hasReplyAll(message, own) ? act("reply_all") : undefined,
            forward: act("forward"),
            later: act("later"),
            park: act("aside"),
            resurface: act("resurface"),
            tag: { onPress: () => setAsk("tag"), keepOpen: true },
          }
        : {}),
      screen: screen ? () => screen(target.anchor) : undefined,
      move: moves.length ? { onPress: () => setAsk("move"), keepOpen: true } : undefined,
      ...(readState && message && !readIsItsRelease(message)
        ? { [message.unread ? "read" : "unread"]: readState }
        : {}),
      ...(pick ? { [picked ? "deselect" : "select"]: () => pick.onPress(false) } : {}),
      delete: canDelete
        ? trashAcknowledged
          ? act("delete")
          : { onPress: () => setAsk("delete"), keepOpen: true }
        : undefined,
    },
    false,
    items,
  );
  if (ask && verbs && message) {
    return (
      <LetterRowAsk
        ask={ask}
        target={target}
        verbs={verbs}
        message={message}
        moves={moves}
        onClose={onClose}
      />
    );
  }
  return <MailRowMenu target={target} onClose={onClose} items={rowItems} />;
}

function LetterRowAsk({
  ask,
  target,
  verbs,
  message,
  moves,
  onClose,
}: {
  ask: "tag" | "move" | "delete";
  target: MenuTarget;
  verbs: ListVerbs;
  message: EngineMessage;
  moves: readonly MoveTarget[];
  onClose: () => void;
}) {
  const t = useText("ohbox");
  const reader = useText("reader");
  const { remember } = useScreenerAcknowledgements();
  const place = useText("place");
  const host = useContext(FrameContext)?.api.host;
  const run = (action: MessageAction) => {
    onClose();
    verbs.onMessageAction(action, message);
  };
  if (ask === "move") {
    return (
      <MovePicker
        open
        anchor={target.anchor}
        onClose={onClose}
        label={t("moveLabel")}
        title={t("moveLabel")}
        places={moves.map((id) => ({ id, label: place(id) }))}
        folders={[]}
        onMove={(id) => run(`move:${id as MoveTarget}`)}
      />
    );
  }
  if (ask === "delete") {
    return (
      <Dialog
        open
        onClose={onClose}
        returnFocus={() => target.anchor}
        title={reader("trashAsk")}
        hot
        kind="delete"
        confirm={{
          label: t("actionMove"),
          onPress: () => {
            remember?.("moveToTrash");
            run("delete");
          },
        }}
        cancel={{ label: reader("resurface.cancel") }}
      />
    );
  }
  const current = host?.engine.verbRead();
  return (
    <TagPicker
      anchor={target.anchor}
      point={"x" in target.at ? target.at : undefined}
      tags={current?.list<TagEntity>("tag") ?? []}
      assigned={current?.get<EngineMessage>("message", message.id)?.labels ?? message.labels ?? []}
      onToggle={(id, assigned) => verbs.bulkToggleTag([message.id], id, assigned)}
      onClose={onClose}
    />
  );
}
