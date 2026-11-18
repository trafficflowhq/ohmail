/**
 * ONE LETTER'S OWN MENU, at its head: answer this letter (not the conversation's newest), forward it, or mark it
 * unread. Answers open `write`'s reply where the shell handed one, else a draft for `write`; nothing is sent here. Mark unread goes through the room's seam.
 * Reply all stands only where its audience differs from Reply's, as on the panel; Mark unread only on a letter that
 * is read and is not the account's own.
 */
import type { EngineMessage } from "@ohmail/wire";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { markSeenOver, mayMarkUnread } from "@ohmail/app-logic/reader";
import { useFrame } from "../../frame/commands.js";
import { useOwnAddresses, usePressWhereOn } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { draftFor, hasReplyAll, useAnswer } from "./use-verbs.js";

export function LetterMenu({
  message,
  anchor,
  onClose,
}: {
  message: EngineMessage;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const t = useText("reader");
  const tm = useText("message");
  const { commands } = useFrame();
  const press = usePressWhereOn();
  const answer = useAnswer();
  const replyAll = hasReplyAll(message, useOwnAddresses());
  const then = (run: () => void) => () => {
    onClose();
    run();
  };
  const answers = (how: "reply" | "reply_all" | "forward") =>
    then(() => (answer !== null ? answer(message.id, how, "menu") : commands.write(draftFor(how, message))));
  return (
    <Menu open={anchor !== null} onClose={onClose} anchor={anchor ?? undefined} label={t("head.menu")} right>
      <MenuItem icon="reply" onPress={answers("reply")}>
        {tm("menuReply")}
      </MenuItem>
      {replyAll ? (
        <MenuItem icon="replyall" onPress={answers("reply_all")}>
          {tm("menuReplyAll")}
        </MenuItem>
      ) : null}
      <MenuItem icon="forward" onPress={answers("forward")}>
        {tm("menuForward")}
      </MenuItem>
      {press !== null && mayMarkUnread(message) ? (
        <MenuItem icon="unread" onPress={then(() => void markSeenOver(press)([message.id], true))}>
          {tm("menuMarkUnread")}
        </MenuItem>
      ) : null}
    </Menu>
  );
}
