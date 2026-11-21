import type { EngineMessage } from "@ohmail/wire";
import { useId, useState, type ReactNode } from "react";
import { BlockedImages, type MessageHeadProps } from "@ohmail/ui/mail";
import {
  awayAnswerStamp,
  headStamp,
  isForwardedByUs,
  letterStampInstant,
  placeOfFolder,
  readerZone,
} from "@ohmail/app-logic/reader";
import { senderCheckFact, senderCheckSentence } from "@ohmail/app-logic/screener";
import { forwardedToNames, recipientRows } from "@ohmail/app-logic/text/format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useMailboxName, useMailboxWord, useOwnAddresses } from "../frame/room.js";
import { DeliveryLabel } from "../place-list/DeliveryLabel.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { LetterMenu } from "./actions/LetterMenu.js";
import type { ContactOf } from "./contact/Contact.js";
import type { LetterNotice } from "./ports.js";

const CARD_RECIPIENT_CHIPS = 2;

const nameOf = (p: { name: string | null; address: string }): string => p.name?.trim() || p.address;

/** A person as the details print them: the name and the whole address, or the address alone. */
const whole = (p: { name: string | null; address: string }): string =>
  p.name?.trim() ? `${p.name.trim()} ${p.address}` : p.address;

export interface LetterHeadProps {
  message: EngineMessage;
  unread: boolean;
  notice: LetterNotice | null;
  copy: string | null;
  narrow: boolean;
  onPerson: (person: ContactOf) => void;
  card: string | null;
  preview?: boolean;
  selection?: MessageHeadProps["selection"];
  streamCard?: "open";
}

/**
 * Who wrote it, to whom and when; every name opens the contact card; what the body kept out, as its chip; what the
 * shell says of its copy in Sent, as a note under the recipients.
 */
export function useLetterHeadPresentation(props: LetterHeadProps) {
  const { message, unread, notice, card, preview = false, streamCard } = props;
  const {
    t,
    tm,
    place,
    delivery,
    noticeOpen,
    setNoticeOpen,
    full,
    setFull,
    details,
    setDetails,
    menu,
    setMenu,
    senderCard,
    mine,
    person,
    forwardTo,
    groups,
    stamp,
    marks,
    screener,
    identity,
    detailName,
    recipientName,
    lines,
  } = useLetterHead(props);
  const head: Omit<MessageHeadProps, "stamp"> = {
    preview: preview,
    selection: props.selection,
    sender: {
      name: nameOf(message.from),
      address: message.from.address,
      displayAddress: displayAddress(message.from.address),
      printed:
        forwardTo !== null
          ? tm("forwardedTo", { name: forwardTo })
          : mine(message.from.address)
            ? t("head.youSender")
            : undefined,
      expanded: card === `${message.id} from`,
      controls: senderCard,
      onPress: person(message.from, `${message.id} from`),
    },
    unread: unread,
    senderCheck: identity ? senderCheckSentence(screener, identity) : undefined,
    amount: streamCard || (preview && (place !== "receipts" || message.subject)) ? undefined : message.amount,
    delivery: delivery ? (
      <DeliveryLabel place={place === "reads"} title={tm("deliveredToTitle", { label: delivery })}>
        {tm("deliveredTo", { label: delivery })}
      </DeliveryLabel>
    ) : undefined,
    deliveryOpen: streamCard === "open",
    note: notice ? (
      <BlockedImages
        caption={notice.caption}
        sentence={notice.text}
        describe={preview}
        open={noticeOpen}
        onOpen={() => setNoticeOpen(true)}
        onClose={() => setNoticeOpen(false)}
      />
    ) : undefined,
    menu: preview
      ? undefined
      : { label: t("head.menu"), expanded: menu !== null || undefined, onPress: (at) => setMenu(at) },
    to: groups,
    details: {
      label: tm("details"),
      name: details ? tm("detailsHideAria") : detailName,
      max: preview ? CARD_RECIPIENT_CHIPS : 3,
      more: (group, shown) => {
        const count = group.people.length - shown.length;
        return {
          text: tm("moreRecipients", { count }),
          name: tm("moreRecipientsAriaField", {
            field: group.word,
            names: shown.map((p) => p.name).join(", "),
            count,
            action: recipientName,
          }),
        };
      },
      open: details,
      onToggle: () => setDetails((d) => !d),
      lines,
    },
    marks: marks,
  };
  return {
    head,
    stamp,
    full,
    setFull,
    menu: !preview && <LetterMenu message={message} anchor={menu} onClose={() => setMenu(null)} />,
  };
}

function useLetterHead({ message, copy, onPerson, card, preview = false, streamCard }: LetterHeadProps) {
  const t = useText("reader");
  const tm = useText("message");
  const tp = useText("place");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const own = useOwnAddresses();
  const mailboxWord = useMailboxWord();
  const mailbox = mailboxWord(message.mailboxId);
  const place = placeOfFolder(message.folder);
  const delivery = (preview || streamCard) && (place === "reads" || place === "receipts") ? mailbox : null;
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const mailboxName = useMailboxName();
  const senderCard = useId();
  const mine = (address: string): boolean => own.some((a) => a.toLowerCase() === address.toLowerCase());
  const name = (p: { name: string | null; address: string }) =>
    mine(p.address) ? mailboxName(p.address) : p.name?.trim() || null;
  const person = (p: { name: string | null; address: string }, slot: string) => (anchor: HTMLElement) => {
    const displayName = name(p);
    onPerson({
      name: displayName ?? displayAddress(p.address),
      displayName,
      address: p.address,
      anchor,
      slot,
      messageId: message.id,
      onSender: p.address.toLowerCase() === message.from.address.toLowerCase(),
      cardId: slot === `${message.id} from` ? senderCard : undefined,
    });
  };
  const forwardTo = isForwardedByUs(message) ? forwardedToNames(message) : null;
  const groups = recipientGroups(message, own, { t, card, preview, mine, name, person });
  const now = new Date();
  const stamp = headStamp(letterStampInstant(message), now, readerZone(), locale, {
    yesterday: (time) => t("head.yesterday", { time }),
  });
  const answered = awayAnswerStamp(message, now, timeZone, locale);
  const marks: NonNullable<MessageHeadProps["marks"]>[number][] = [];
  if (copy !== null) marks.push({ text: copy });
  if (answered !== null) {
    const label = tm("awayAnswered");
    marks.push({
      text: label,
      ariaLabel: answered.full ? tm("awayAnsweredAria", { whenLong: answered.full }) : label,
      content: answered.when
        ? tm.rich("awayAnsweredAt", {
            label,
            when: answered.when,
            stamp: (chunks: ReactNode) => <span className="oh-messagehead-markwhen">{chunks}</span>,
          })
        : undefined,
    });
  }
  const screener = useText("screener");
  const identity = senderCheckFact(message);
  const hasDate = Boolean(stamp.full);
  const hasFolder = Boolean(message.physicalFolder);
  const detailName =
    hasDate && hasFolder
      ? tm("detailsAria")
      : hasDate
        ? tm("detailsAriaDate")
        : hasFolder
          ? tm("detailsAriaFolder")
          : undefined;
  const recipientName =
    hasDate && hasFolder
      ? tm("moreRecipientsAria")
      : hasDate
        ? tm("moreRecipientsAriaDate")
        : hasFolder
          ? tm("moreRecipientsAriaFolder")
          : tm("moreRecipientsAriaOnly");
  const lines = details ? detailLines({ message, place, mailbox, t, tp, date: stamp.full }) : [];
  return {
    t,
    tm,
    place,
    delivery,
    noticeOpen,
    setNoticeOpen,
    full,
    setFull,
    details,
    setDetails,
    menu,
    setMenu,
    senderCard,
    mine,
    person,
    forwardTo,
    groups,
    stamp,
    marks,
    screener,
    identity,
    detailName,
    recipientName,
    lines,
  };
}

type Person = EngineMessage["from"];

function recipientGroups(
  message: EngineMessage,
  own: readonly string[],
  {
    t,
    card,
    preview,
    mine,
    name,
    person,
  }: {
    t: Text;
    card: string | null;
    preview: boolean;
    mine: (address: string) => boolean;
    name: (person: Person) => string | null;
    person: (person: Person, slot: string) => (anchor: HTMLElement) => void;
  },
) {
  const recipients = recipientRows(message, own);
  // A folded preview can say “you” for one addressee without exposing a lone list address.
  const recipientCount = recipients.to.length + recipients.cc.length;
  const showRecipients =
    !preview ||
    recipientCount > 1 ||
    recipients.to.some((person) => person.me) ||
    recipients.cc.some((person) => person.me);
  const groups = [
    { word: t("head.to"), people: recipients.to, slot: "to" },
    { word: t("head.cc"), people: recipients.cc, slot: "cc" },
  ]
    .filter((g) => g.people.length > 0)
    .map((g) => ({
      word: g.word,
      people: g.people
        .map((p, i) => {
          const slot = `${message.id} ${g.slot} ${i}`;
          if (preview && recipientCount === 1 && p.me) {
            return { isOwn: true, name: t("head.you"), textOnly: true };
          }
          const isOwn = mine(p.address);
          const displayName = name(p);
          return {
            isOwn,
            name: isOwn ? t("head.you") : (displayName ?? displayAddress(p.address)),
            title: isOwn && displayName ? `${displayName} <${p.address}>` : p.address,
            expanded: card === slot,
            onPress: person(p, slot),
          };
        })
        .sort((left, right) => Number(right.isOwn) - Number(left.isOwn)),
    }));
  return showRecipients ? groups : undefined;
}

/* When, who, to whom with every address whole, and where it is: its place, and its mailbox where there are several. */
function detailLines({
  message,
  place,
  mailbox,
  t,
  tp,
  date,
}: {
  message: EngineMessage;
  place: ReturnType<typeof placeOfFolder>;
  mailbox: string | null;
  t: Text;
  tp: Text;
  date: string;
}) {
  const location = place !== null && tp.has(place) ? tp(place) : message.folder;
  return [
    ...(date ? [{ term: t("sent"), value: date }] : []),
    { term: t("from"), value: nameOf(message.from), note: message.from.address },
    ...(message.to.length > 0 ? [{ term: t("detail.to"), value: message.to.map(whole).join(", ") }] : []),
    ...(message.cc.length > 0 ? [{ term: t("detail.cc"), value: message.cc.map(whole).join(", ") }] : []),
    ...(message.physicalFolder
      ? [
          {
            term: t("detail.in"),
            value: mailbox ? t("detail.where", { place: location, mailbox }) : location,
          },
        ]
      : []),
  ];
}
