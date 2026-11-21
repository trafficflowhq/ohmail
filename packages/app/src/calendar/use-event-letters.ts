import { eventLetters } from "@ohmail/app-logic/calendar/beside";
import { placeOfFolder } from "@ohmail/app-logic/reader";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import type { FolderEntity, MessageDTO } from "@ohmail/wire";
import { useMemo } from "react";
import { useFrame } from "../frame/commands.js";
import { locationOfMailView } from "../frame/route.js";
import { NONE } from "../host/index.js";
import type { CalendarEventFace } from "./faces.js";

export function useEventLetters(event: CalendarEventFace) {
  const { host, commands } = useFrame();
  const mirror = usePresentedMirror();
  const port = host.wires.calendar;
  const uid =
    event.viewOnly || port === NONE
      ? undefined
      : port.events().find(({ record }) => record.id === event.recordId)?.record.uid;
  const stamp = mirror?.stampOf("message");
  const letters = useMemo(
    () => (uid && mirror && stamp !== undefined ? eventLetters(uid, mirror.list<MessageDTO>("message")) : []),
    [mirror, stamp, uid],
  );
  return letters.flatMap((letter) => {
    const view = locationOfMailView(placeOfFolder(letter.folder));
    const folder = view
      ? undefined
      : mirror
          ?.list<FolderEntity>("folder")
          .find((folder) => folder.mailboxId === letter.mailboxId && folder.name === letter.folder);
    const to = view ?? (folder ? { place: "folder" as const, sub: folder.id } : null);
    return to ? [{ ...letter, open: () => commands.go({ ...to, open: letter.id }, { entered: true }) }] : [];
  });
}
