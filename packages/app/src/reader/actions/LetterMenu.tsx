/**
 * ONE LETTER'S OWN MENU, at its head: answer this letter (not the conversation's newest), forward it, or mark it
 * unread. Answers hand a draft to `write`; nothing is sent from here. Mark unread goes through the room's seam.
 */
import { Menu, MenuItem } from "@ohmail/ui/base";
import { markSeenOver } from "@ohmail/app-logic/reader";
import type { EngineMessage } from "@ohmail/client-engine";
import { useFrame } from "../../frame/commands.js";
import { usePressWhereOn } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { draftFor } from "./use-verbs.js";

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
  const then = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Menu open={anchor !== null} onClose={onClose} anchor={anchor ?? undefined} label={t("head.menu")} right>
      <MenuItem icon="reply" onPress={then(() => commands.write(draftFor("reply", message)))}>
        {tm("menuReply")}
      </MenuItem>
      <MenuItem icon="replyall" onPress={then(() => commands.write(draftFor("reply_all", message)))}>
        {tm("menuReplyAll")}
      </MenuItem>
      <MenuItem icon="forward" onPress={then(() => commands.write(draftFor("forward", message)))}>
        {tm("menuForward")}
      </MenuItem>
      {press !== null && !message.unread ? (
        <MenuItem icon="unread" onPress={then(() => void markSeenOver(press)([message.id], true))}>
          {tm("menuMarkUnread")}
        </MenuItem>
      ) : null}
    </Menu>
  );
}
