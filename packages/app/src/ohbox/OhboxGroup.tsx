/**
 * ONE GROUP OF THE OHBOX: its heading and its rows, as options of one listbox. Each row is the kit's row; what it
 * says comes from the model (who waits, whether it is open, Done) and from the shell's words (names, times, tags).
 */
import { useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import type { OhboxRow, ThreadMark } from "@ohmail/client-engine";
import { useWalkedSquares, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { claimFact, senderCheckSentence } from "@ohmail/app-logic/screener";
import { Tag } from "@ohmail/ui/base";
import { GroupHeading, ReadSquares, Row, Rows, type SquareKind } from "@ohmail/ui/mail";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import type { ContactOf } from "../reader/contact/Contact.js";
import { useLocale, useText } from "../text/index.js";
import { useRowSwipe } from "../touch/index.js";
import type { OhboxBeside } from "./beside.js";
import { OhboxRowMenu } from "./OhboxRowMenu.js";
import { ohboxRowSides } from "./row-sides.js";
import { peopleOf, spokenOf, whoOf, type RowWho } from "./row-words.js";
import { useSquaresRun } from "./squares-run.js";

export interface OhboxGroupProps {
  model: OhboxListModel;
  beside: OhboxBeside;
  /** On the phone the personal tag leaves room for the sender's address. */
  showTaggedByline?: boolean;
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
  showTaggedByline = false,
  name,
  rows,
  from,
  to,
  headingIndex,
  rowBase,
  heading,
}: OhboxGroupProps) {
  const t = useText("ohbox");
  const {
    host: {
      features: { reader },
    },
  } = useFrame();
  const ScreenContact = reader === NONE ? undefined : reader.Screening;
  const [contact, setContact] = useState<{ person: ContactOf; openId: string | undefined } | null>(null);
  const openId = model.selected?.id;
  const showScreening = (letter: EngineMessage, anchor: HTMLElement) =>
    setContact({
      person: {
        messageId: letter.id,
        slot: `${letter.id} from`,
        name: beside.words.name(letter),
        address: letter.from.address,
        anchor,
      },
      openId,
    });
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
              showTaggedByline={showTaggedByline}
              row={row}
              index={rowBase === undefined ? undefined : rowBase + from + k}
              place={{ at: from + k + 1, of: rows.length }}
              onMenu={(at) => setMenu({ row, at })}
              onContact={ScreenContact && model.picked.size === 0 ? showScreening : undefined}
              words={t}
            />
          ))}
        </Rows>
      ) : null}
      {contact &&
      ScreenContact &&
      contact.openId === openId &&
      model.picked.size === 0 &&
      contact.person.anchor.isConnected ? (
        <ScreenContact
          key={contact.person.slot}
          direct
          person={contact.person}
          onClose={() => setContact(null)}
        >
          {() => null}
        </ScreenContact>
      ) : null}
      {menu ? <OhboxRowMenu model={model} row={menu.row} at={menu.at} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/** One mailbox written two ways is one person: an address is compared without its case. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface OhboxRowItemProps {
  model: OhboxListModel;
  beside: OhboxBeside;
  showTaggedByline: boolean;
  row: OhboxRow;
  index: number | undefined;
  place: { at: number; of: number };
  onMenu: (at: { x: number; y: number }) => void;
  onContact?: (letter: EngineMessage, anchor: HTMLElement) => void;
  words: ReturnType<typeof useText>;
}

function OhboxRowItem({
  model,
  beside,
  showTaggedByline,
  row,
  index,
  place,
  onMenu,
  onContact,
  words: t,
}: OhboxRowItemProps) {
  const w = beside.words;
  const locale = useLocale();
  const screening = useText("screening");
  const face = row.face;
  const senderCheck = useSenderCheckChip(face);
  const single = row.members.length === 1;
  const sent = single || row.unreadCount === 0 ? w.sentTo(face) : null;
  const voices = model.groupVoices(row);
  const who = whoOf(voices, w.name, w.address, sent);
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
      address={marks || (tag && !showTaggedByline) ? undefined : who.address}
      senderCheck={senderCheck}
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
      selection={{
        label: t("keyPick"),
        onPress: (extend) => (extend ? model.pickRangeTo : model.togglePick)(row.openTarget.id),
      }}
      onMenu={onMenu}
      {...rowContact(who, onContact, (sender) => screening("openFor", { sender }))}
      swipe={swipe}
      listing={{
        name: `${who.names}: ${subject}`,
        spoken: spokenOf({
          when: stamp.spoken,
          unread: unread ? t("row.unread") : t("row.read"),
          marks: marksWords,
          file,
          identity: senderCheck?.title,
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

function rowContact(who: RowWho, open: OhboxRowItemProps["onContact"], label: (name: string) => string) {
  if (!open) return {};
  const addressSource = who.byline.length === 1 ? who.byline[0]?.letter : undefined;
  return {
    nameActions: who.byline.map(({ letter, name, text }) => ({
      id: letter.id,
      text,
      label: label(name),
      onPress: (anchor: HTMLElement) => open(letter, anchor),
    })),
    addressAction: addressSource ? (anchor: HTMLElement) => open(addressSource, anchor) : undefined,
  };
}

function useSenderCheckChip(face: EngineMessage) {
  const screener = useText("screener");
  const claim = claimFact(face);
  return claim?.reason === "impersonation"
    ? {
        label: screener("senderCheck.chip", { brand: claim.brand }),
        title: senderCheckSentence(screener, claim),
      }
    : undefined;
}
