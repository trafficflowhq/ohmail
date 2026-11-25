import type { OhboxRow } from "@ohmail/client-engine";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import { MailRowMenu, useMailRowItems } from "../place-list/MailRowMenu.js";
import { useOwnAddresses } from "../frame/room.js";
import { hasReplyAll } from "../reader/actions/use-verbs.js";
import type { RowAsk } from "@ohmail/app-logic/ohbox";

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
  const picked = row.members.every((m) => model.picked.has(m.id));
  const replyAll = hasReplyAll(row.openTarget, useOwnAddresses());
  const act = (action: MessageAction) => () => model.actOn(row, action);
  const ask = (kind: RowAsk["kind"]) => () =>
    onAsk?.({ kind, letter: row.openTarget, act: (action) => model.actOn(row, action, "letter") });
  const items = useMailRowItems(
    {
      open: () => model.open(row.openTarget),
      reply: act("reply"),
      replyAll: replyAll ? act("reply_all") : undefined,
      forward: act("forward"),
      later: act("later"),
      park: act("aside"),
      resurface: act("resurface"),
      tag: () => model.tagRow(row, anchor, at),
      screen: onScreen,
      move: onAsk ? ask("move") : undefined,
      ...(model.doneOffered(row)
        ? { done: () => model.doneRow(row) }
        : { unread: () => model.markUnread(row.openTarget) }),
      [picked ? "deselect" : "select"]: () => model.togglePick(row.openTarget.id),
      delete: onAsk && canDelete ? ask("delete") : undefined,
    },
    true,
  );
  return <MailRowMenu target={{ at, anchor }} onClose={onClose} items={items} />;
}
