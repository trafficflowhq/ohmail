"use client";

/**
 * THE ONE SEND MACHINE'S LINES IN THE FRAME'S NOTICE SLOT: a letter that did not leave (`notSent`, hot, naming whom
 * and what it was for), a send queued or on its way and one just sent (`sending`), and the changes this browser could
 * not save or has not sent yet (`unsaved`, hot while one was given up); and each letter that went out without its
 * copy in Sent (`sentCopy`), as the foot line said it under its name until its Dismiss. Moved word for word from the
 * web shell's feed (`todays-feeds.tsx`: `aboutOf`, `sendingNotice`, `unsavedTitle`, and the slot's `mountLine`), each
 * answered by one hook, read off the composer's one record and never a second machine.
 *
 * WHAT THE LINE SAID BESIDE WHOM: a letter not sent, or one queued, carries the sentence the sidebar's foot line said
 * under its name (`SendingLine.tsx`): its editor's own line (`sendLine`), "Sending didn't work — your draft is kept",
 * so the notice says that it did not leave, never only to whom it was.
 *
 * THEIR ACTS. "Open" on one letter is the record's own door back (`openNotSent`): the letter with every word, or its
 * editor while it waits; once it opened, an ending leaves the line, as the foot line's Open took it. A send on its way
 * and one just sent have no act, as on the foot line. Several letters not sent open the Drafts list where it is
 * mounted. Each letter has its own Open in the notice slot where the host does not mount Drafts. "Show
 * them" on the `unsaved` notice opens the list of the changes that were not saved (`UnsavedList`), with each one's
 * reason, Try again and Discard.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useAbandoned } from "@ohmail/app-logic/engine";
import { footLineSeen } from "@ohmail/app-logic/layout/narrow";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import {
  COMPOSE_SEND_KEY,
  sentCopySay,
  type MailSendApi,
  type SendLineItem,
} from "@ohmail/app-logic/writing/mail-send";
import { lineRows, sendLine, sendLineValuesOver, type LineRow } from "@ohmail/app-logic/writing/send-line";
import { useFrame, type FrameNotice } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useTextLookup } from "../../text/index.js";
import { unsavedTitle, useQueued, useShowUnsaved } from "./UnsavedList.js";
import { COMPOSER_WORDS, fileSize } from "./writing-words.js";

/** A sentence of the whole catalogue by its namespaced key (`sendingLine.sent`), as the web shell's feed said it. */
type T = (key: string, values?: Record<string, string | number>) => string;

function useWords(): T {
  const text = useTextLookup();
  return (key, values) => {
    const dot = key.indexOf(".");
    return text(key.slice(0, dot))(key.slice(dot + 1), values);
  };
}

/** Which message an outcome is about, as the sending line names it. */
function aboutOf(t: T, item: SendLineItem): string | null {
  return item.to !== null && item.subject !== null
    ? t("sendingLine.aboutBoth", { name: item.to, subject: item.subject })
    : item.to !== null
      ? t("sendingLine.aboutTo", { name: item.to })
      : item.subject !== null
        ? t("sendingLine.aboutSubject", { subject: item.subject })
        : null;
}

/** The sentence one letter's own editor says of its send, in its own lane's words (`compose` or `reply`). */
function sentenceOf(t: T, item: SendLineItem, key: string): string {
  return t(`${item.key === COMPOSE_SEND_KEY ? "compose" : "reply"}.${key}`, sendLineValuesOver(fileSize));
}

/** The send line's first row as a notice, with its one act; null when nothing stands on the line. */
export function sendingNotice(
  t: T,
  items: readonly SendLineItem[],
  open: (row: readonly SendLineItem[]) => void,
): FrameNotice | null {
  const row = lineRows(items)[0];
  return row ? rowNotice(t, row, open) : null;
}

/** One row of the send line (`lineRows`) as a notice, with its one act. */
function rowNotice(t: T, row: LineRow, open: (row: readonly SendLineItem[]) => void): FrameNotice {
  const one = row.items.length === 1 ? row.items[0]! : null;
  const showAct = { label: t("sendingLine.open"), onPress: () => open(row.items) };
  /* Whom and what, and beside it what the letter's own editor says: the foot line's title and its sentence. */
  const said = (sentence: string): { title: string; line?: string } => {
    const named = one === null ? null : aboutOf(t, one);
    return named === null ? { title: sentence } : { title: named, line: sentence };
  };
  if (row.kind === "ended") {
    if (one === null)
      return {
        kind: "notSent",
        hot: true,
        title: t("compose.notSentMany", { count: row.items.length }),
        acts: [showAct],
      };
    const line = one.ended ? sendLine(one.ended, false) : null;
    return {
      kind: "notSent",
      hot: true,
      ...said(line ? sentenceOf(t, one, line.key) : t("reply.statusFailed")),
      acts: [showAct],
    };
  }
  if (row.kind === "queued")
    return one !== null
      ? { kind: "sending", ...said(sentenceOf(t, one, "statusQueued")), acts: [showAct] }
      : { kind: "sending", title: t("compose.statusQueued") };
  const title =
    row.kind === "sending"
      ? one === null
        ? t("sendingLine.sendingMany", { count: row.items.length })
        : one.to !== null
          ? t("sendingLine.sending", { name: one.to })
          : t("sendingLine.sendingUnnamed")
      : one === null || one.to === null
        ? t("sendingLine.sent")
        : one.subject !== null
          ? t("sendingLine.sentToAbout", { name: one.to, subject: one.subject })
          : t("sendingLine.sentTo", { name: one.to });
  return { kind: "sending", title };
}

/** A delivered letter whose Sent copy has a note: it stands on the line until its own Dismiss. */
const noted = (item: SendLineItem): boolean => item.state === "sent" && item.copy !== undefined;

/**
 * THE SEND LINE AS THE SLOT's NOTICES. Each letter whose Sent copy has a note is its own notice, the oldest first, as
 * the foot line stood them (`lineRows`): to whom and what it was, why its copy is not in Sent (`sentCopySay`, hot
 * where the copy is missing, as the foot line's warning was), and Dismiss, which takes that note off the line and out
 * of this browser. Each of the line's other rows is its own notice too, as the foot line stood every row present (the
 * endings first): a note never stands in front of a letter that did not leave, and a letter that did not leave never
 * hides the next one going or gone. Two rows of one kind are told apart by their first letter.
 */
export function sendNotices(
  t: T,
  items: readonly SendLineItem[],
  open: (row: readonly SendLineItem[]) => void,
  dismiss: (id: string) => void,
  draftsAvailable = true,
): FrameNotice[] {
  const notes = items
    .filter(noted)
    .reverse()
    .map((one): FrameNotice => {
      const why = sentCopySay(one.copy!, COMPOSER_WORDS.scheduleLabel);
      const title =
        one.to === null
          ? t("sendingLine.sent")
          : one.subject !== null
            ? t("sendingLine.sentToAbout", { name: one.to, subject: one.subject })
            : t("sendingLine.sentTo", { name: one.to });
      return {
        kind: "sentCopy",
        id: one.id,
        hot: one.copy!.state === "missing",
        title,
        line: t(why.key, why.values),
        acts: [{ label: t("sendingLine.dismiss"), onPress: () => dismiss(one.id) }],
      };
    });
  const rows = lineRows(items.filter((item) => !noted(item))).flatMap((row): LineRow[] =>
    row.kind === "ended" && !draftsAvailable
      ? row.items.map((item) => ({ kind: "ended", items: [item] }))
      : [row],
  );
  const rest = rows.map((row): FrameNotice => ({
    ...rowNotice(t, row, open),
    id: `${row.kind}:${row.items[0]!.id}`,
  }));
  return [...notes, ...rest];
}

/** The part of the composer's record the notices read: the send machine's line, and the door back to a letter. */
type SendLine = Pick<MailSendApi, "line" | "subscribeLine" | "lineVersion" | "mountLine" | "dismissLine">;

/** The send machine's line as notices: not sent, sending, sent, each copy note; their Open and Dismiss. */
export function useSendingNotices(): readonly FrameNotice[] {
  const t = useWords();
  const { commands, host } = useFrame();
  const draftsAvailable = host.features.places.drafts !== NONE;
  const { mailSend, openNotSent } = useComposer();
  const line: SendLine = mailSend;
  /* The slot says a send's ending where today's two lines were seen (the rail's foot, or the narrow-width pill), by
     today's own rule; where neither was, the ending is a report, as today. */
  const { mountLine } = line;
  useEffect(() => mountLine(() => footLineSeen("rail") || footLineSeen("shell")), [mountLine]);
  useSyncExternalStore(line.subscribeLine, line.lineVersion, line.lineVersion);
  const open = (items: readonly SendLineItem[]): void => {
    const one = items.length === 1 ? items[0]! : null;
    if (one === null) {
      if (!draftsAvailable) return;
      commands.go({ place: "drafts" });
      for (const item of items) if (item.state === "ended") line.dismissLine(item.id);
      return;
    }
    if (openNotSent(one.key, one.left, one.m, one.state !== "ended") && one.state === "ended")
      line.dismissLine(one.id);
  };
  return sendNotices(t, line.line(), open, line.dismissLine, draftsAvailable);
}

/** The changes not saved or not sent yet, with "Show them", which opens their list (`UnsavedList`, mounted above). */
export function useUnsavedNotice(): FrameNotice | null {
  const t = useWords();
  const show = useShowUnsaved();
  const abandoned = useAbandoned();
  const queued = useQueued();
  const title = unsavedTitle(t, abandoned.length, queued.length);
  return title === null
    ? null
    : {
        kind: "unsaved",
        hot: abandoned.length > 0,
        title,
        acts: [{ label: t("sync.unsavedShow"), onPress: show }],
      };
}
