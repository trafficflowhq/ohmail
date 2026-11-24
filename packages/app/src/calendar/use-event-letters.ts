import { eventLetters } from "@ohmail/app-logic/calendar/beside";
import { isProtected, placeOfFolder } from "@ohmail/app-logic/reader";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import type { FolderEntity, MessageDTO } from "@ohmail/wire";
import { useMemo } from "react";
import { useFrame } from "../frame/commands.js";
import { locationOfMailView } from "../frame/route.js";
import { useFound } from "../frommail/use-found.js";
import { NONE } from "../host/index.js";
import type { CalendarEventFace } from "./faces.js";

export function useEventLetters(event: CalendarEventFace | undefined) {
  const { host } = useFrame();
  const mirror = usePresentedMirror();
  const port = host.wires.calendar;
  const uid =
    !event || event.viewOnly || port === NONE
      ? undefined
      : port.events().find(({ record }) => record.id === event.recordId)?.record.uid;
  const fromMail = useFound(uid ? port : NONE);
  const stamp = mirror?.stampOf("message");
  const letters = useMemo(() => {
    if (!uid || !mirror || stamp === undefined) return [];
    const messages = mirror.list<MessageDTO>("message");
    const tied = eventLetters(uid, messages);
    const matched = fromMail?.rows.filter((row) => row.alreadyOn?.event === event?.recordId) ?? [];
    const found = messages.filter(
      (letter) =>
        !isProtected(letter) &&
        !tied.some((known) => known.id === letter.id) &&
        matched.some((row) => row.messageId === letter.id && row.mailboxId === letter.mailboxId),
    );
    return [...tied, ...found];
  }, [mirror, stamp, uid, fromMail, event?.recordId]);
  const openLetter = useOpenCalendarLetter();
  const links = letters.flatMap((letter) => {
    const open = openLetter(letter);
    return open ? [{ ...letter, open }] : [];
  });
  return { letters, links };
}

export function useCalendarLetter(id: string | undefined, mailboxId: string | undefined) {
  const { host } = useFrame();
  const mirror = usePresentedMirror();
  const openLetter = useOpenCalendarLetter();
  if (id === undefined || host.capabilities.products !== "both") return undefined;
  const letter = mirror
    ?.list<MessageDTO>("message")
    .find((message) => message.id === id && message.mailboxId === mailboxId);
  const open = letter && !isProtected(letter) ? openLetter(letter) : undefined;
  return open && letter ? { subject: letter.subject, open } : undefined;
}

function useOpenCalendarLetter() {
  const { commands } = useFrame();
  const mirror = usePresentedMirror();
  return (letter: MessageDTO) => {
    const view = locationOfMailView(placeOfFolder(letter.folder));
    const folder = view
      ? undefined
      : mirror
          ?.list<FolderEntity>("folder")
          .find((folder) => folder.mailboxId === letter.mailboxId && folder.name === letter.folder);
    const to = view ?? (folder ? { place: "folder" as const, sub: folder.id } : null);
    return to ? () => commands.go({ ...to, open: letter.id }, { entered: true }) : undefined;
  };
}
