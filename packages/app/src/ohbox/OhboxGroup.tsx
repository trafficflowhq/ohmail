/**
 * ONE GROUP OF THE OHBOX: its heading and its rows, as options of one listbox. Each row is the kit's row; what it
 * says comes from the model (who waits, whether it is open, Done) and from the shell's words (names, times, tags).
 */
import { useState } from "react";
import type { OhboxRow, ThreadMark } from "@ohmail/client-engine";
import { useWalkedSquares, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { Tag } from "@ohmail/ui/base";
import { GroupHeading, ReadSquares, Row, Rows, type SquareKind } from "@ohmail/ui/mail";
import { useLocale, useText } from "../text/index.js";
import { useRowSwipe } from "../touch/index.js";
import type { OhboxBeside } from "./beside.js";
import { OhboxRowMenu } from "./OhboxRowMenu.js";
import { ohboxRowSides } from "./row-sides.js";
import { peopleOf, spokenOf, whoOf } from "./row-words.js";
import { useSquaresRun } from "./squares-run.js";

export interface OhboxGroupProps {
  model: OhboxListModel;
  beside: OhboxBeside;
  /** The group's name, said by its heading and its listbox. */
  name: string;
  /** Every row of the group, for its count and its dot. */
  rows: readonly OhboxRow[];
  /** The rows drawn now: the window's share, or all. */
  from: number;
  to: number;
  /** The window's index of the heading, and of the group's first row. Absent: the group is drawn whole. */
  headingIndex?: number;
  rowBase?: number;
  /** The heading is drawn (the window has reached it). */
  heading: boolean;
}

const SQUARE: Record<ThreadMark, SquareKind> = { read: "seen", unread: "unseen", mine: "own" };

export function OhboxGroup({
  model,
  beside,
  name,
  rows,
  from,
  to,
  headingIndex,
  rowBase,
  heading,
}: OhboxGroupProps) {
  const t = useText("ohbox");
  const [menu, setMenu] = useState<{ row: OhboxRow; at: { x: number; y: number } } | null>(null);
  const drawn = rows.slice(from, to);
  const hot = rows.some(model.rowUnread);
  return (
    <>
      {heading ? (
        <div className="ob-heading" data-index={headingIndex}>
          <GroupHeading count={String(rows.length)} hot={hot}>
            {name}
          </GroupHeading>
        </div>
      ) : null}
      {drawn.length > 0 ? (
        <Rows label={name} many>
          {drawn.map((row, k) => (
            <OhboxRowItem
              key={row.key}
              model={model}
              beside={beside}
              row={row}
              index={rowBase === undefined ? undefined : rowBase + from + k}
              place={{ at: from + k + 1, of: rows.length }}
              onMenu={(at) => setMenu({ row, at })}
              words={t}
            />
          ))}
        </Rows>
      ) : null}
      {menu ? <OhboxRowMenu model={model} row={menu.row} at={menu.at} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/** One mailbox written two ways is one person: an address is compared without its case. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function OhboxRowItem({
  model,
  beside,
  row,
  index,
  place,
  onMenu,
  words: t,
}: {
  model: OhboxListModel;
  beside: OhboxBeside;
  row: OhboxRow;
  index: number | undefined;
  place: { at: number; of: number };
  onMenu: (at: { x: number; y: number }) => void;
  words: ReturnType<typeof useText>;
}) {
  const w = beside.words;
  const locale = useLocale();
  const face = row.face;
  const single = row.members.length === 1;
  const sent = single || row.unreadCount === 0 ? w.sentTo(face) : null;
  const voices = model.groupVoices(row);
  const who = whoOf(voices, w.name, w.address, sent);
  /* A row that speaks for its recipient ("Me → Nora Lindt") leads with its recipient's circle, as the shipped row's
     did: the account's own face never leads a row somebody else stands on. Where the recipient wrote in the
     conversation they stand first and everybody else follows in their order, the account in its place; a row whose
     one person is the account itself wears the recipient's circle alone. Every other row is everybody in it, its
     voices first. */
  const all = model.groupPeople(row);
  const to = sent !== null ? face.to[0] : undefined;
  const lead =
    to === undefined ? -1 : all.findIndex((p) => !p.you && sameAddress(p.letter.from.address, to.address));
  const ordered = lead > 0 ? [all[lead]!, ...all.slice(0, lead), ...all.slice(lead + 1)] : all;
  const everybody = peopleOf(ordered, w.name, t("row.you"), locale);
  const { more } = everybody;
  const alone = to !== undefined && everybody.count === 1 ? to : undefined;
  const people =
    alone === undefined ? everybody.people : [{ name: alone.name ?? alone.address, address: alone.address }];
  const subject = model.subjectOf(row);
  const unread = model.rowUnread(row);
  /* The walked conversation draws itself as it stands, with the reader's ring and a press that jumps; every other
     row draws its own marks. One group of squares a row, in every state. */
  const own = model.marksOf(row);
  const walked = useWalkedSquares(model, row, own);
  const marks = walked?.marks ?? own;
  const run = useSquaresRun(marks?.length ?? 0, walked?.here ?? -1);
  const unreadMarks = marks ? marks.filter((k) => k === "unread").length : 0;
  const marksWords = marks ? t("row.marks", { count: marks.length, unread: unreadMarks }) : null;
  const file = row.members.some((m) => m.hasAttachments) ? t("row.file") : null;
  const stamp = w.stamp(face);
  const tag = w.tag(row.openTarget);
  const picked = model.pickState(row.members.every((m) => model.picked.has(m.id)));
  const open = model.rowOpen(row);
  const swipe = useRowSwipe(row.openTarget.id, ohboxRowSides(model, row, t));
  return (
    <Row
      who={who.who}
      address={marks || tag ? undefined : who.address}
      people={people}
      peopleMore={more > 0 ? `+${more}` : undefined}
      peopleLabel={
        everybody.names === null
          ? undefined
          : t("row.people", { count: everybody.count, names: everybody.names })
      }
      subject={subject}
      preview={face.protected ? t("protectedPreview") : face.snippet}
      when={stamp.when}
      whenTitle={stamp.title}
      onWhen={beside.flipTime}
      file={file ?? undefined}
      squares={
        marks ? (
          <ReadSquares
            squares={marks.map((k) => SQUARE[k])}
            here={walked?.here ?? undefined}
            onJump={walked?.jump}
            run={run}
            axis="row"
            label={marksWords ?? ""}
          />
        ) : undefined
      }
      tag={tag ? <Tag hue={tag.hue}>{tag.name}</Tag> : undefined}
      unread={unread}
      open={open}
      located={beside.located != null && row.members.some((m) => m.id === beside.located)}
      picked={picked === true}
      quick={
        model.doneOffered(row)
          ? { label: t("actionDone"), icon: "check", onPress: () => model.doneRow(row) }
          : undefined
      }
      onOpen={() => model.pressRow(row)}
      onMenu={onMenu}
      swipe={swipe}
      listing={{
        name: `${who.names}: ${subject}`,
        spoken: spokenOf({
          when: stamp.spoken,
          unread: unread ? t("row.unread") : t("row.read"),
          marks: marksWords,
          file,
        }),
        selected: picked ?? open,
        place,
        stop: open,
      }}
      mark={{
        id: row.openTarget.id,
        ids: row.members.length > 1 ? row.members.map((m) => m.id) : undefined,
        index,
        unseen: unread,
      }}
    />
  );
}
