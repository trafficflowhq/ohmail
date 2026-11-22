/**
 * THE OHBOX'S SEAT: what stands above the Ohbox's two columns, and the value of its registration's `Above`. It hands
 * the frame's side and what only a file of this package can read to the Ohbox's live hook (`useOhboxLive`, called
 * here once), and stands the model and the words beside the list (`OhboxAbove`). Mounted with the Ohbox's columns
 * and unmounted with them. THE MODEL OF A PLACE'S SEAT: another place's `Seat.tsx` has this shape.
 *
 * It reads the ground through the live hook's readers and never mounts a piece of it. NOT HERE, each absent until
 * the part that draws it stands: Pull new mail (the ground's feeder hands it, with the rail's foot), the rows as
 * shape before the first mail, the cards over the list's head and the sender's sheet. A row dragged
 * to a rail place is the frame's gesture over the list's own verbs (`useRailDrag`).
 */
import type { EngineMessage, TagEntity } from "@ohmail/wire";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useOhboxLive, type ListAnswer, type OhboxLiveOwn, type RowAsk } from "@ohmail/app-logic/ohbox";
import { wordsOver } from "@ohmail/app-logic/reader";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useMailboxFacts } from "@ohmail/app-logic/mail-state";
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { usePull } from "@ohmail/app-logic/session/pull-new-mail";
import { answerThrough, type ComposerAnswers } from "@ohmail/app-logic/writing/answer";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { useWriting } from "../write/above.js";
import { avatarHue, rowAddress, rowStamp, senderName, tagsOfMessage } from "@ohmail/app-logic/text/format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useFrame, usePaletteOffers, useResumingReader, useSelectionBar } from "../frame/commands.js";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { useRailDrag } from "../frame/rail-drag.js";
import { useOwnAddresses, usePress } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { hasReplyAll } from "../reader/actions/use-verbs.js";
import { scrollerOf } from "../reader/read-dom.js";
import { useScreener } from "../screener/contract.js";
import { TagPicker } from "../tags/TagPicker.js";
import { tagHue } from "../tags/colours.js";
import { useText, useTimeZone } from "../text/index.js";
import { type OhboxBeside } from "./beside.js";
import { rowOf, SEATED, useListKeepsKeyboard, useRowFocusFollow, type Page } from "./keyboard.js";
import { OhboxAbove } from "./OhboxAbove.js";
import { OhboxRowAsk } from "./OhboxRowAsk.js";

/**
 * THE PAGE THE OHBOX IS DRAWN IN, read through the list's own scroller once the list stands: the seat draws no
 * element of its own, and shared code touches no global.
 */
function usePage(): { readonly read: Page; readonly from: (list: RefObject<HTMLElement | null>) => void } {
  const list = useRef<RefObject<HTMLElement | null> | null>(null);
  return useMemo(
    () => ({
      read: () => list.current?.current?.ownerDocument ?? null,
      from: (ref) => {
        list.current = ref;
      },
    }),
    [],
  );
}

/**
 * A ROW ENTERED WHERE ONE COLUMN STANDS hands the keyboard to the letter over the list once the letter stands, as a
 * sheet took it. A walk by `j` enters nothing and keeps the keyboard; the list's rule gives it back when the letter
 * closes.
 */
function useKeyboardToEnteredLetter(
  open: string | null,
  page: Page,
  oneColumn: boolean,
): (id: string) => void {
  const entered = useRef<string | null>(null);
  /* A LETTER THE WINDOW'S NARROWING STANDS OVER THE LIST takes the keyboard too, as today's sheet took it when the
     crossing raised it: else Escape closes it with the keyboard nowhere, and the list's rule has nothing to give back. */
  const wasOneColumn = useRef(oneColumn);
  if (oneColumn && !wasOneColumn.current && open !== null) entered.current = open;
  wasOneColumn.current = oneColumn;
  useEffect(() => {
    const id = entered.current;
    if (id === null || open !== id) return;
    const column = scrollerOf(page()?.querySelector("section.fr-reading") ?? null);
    if (column === null) return;
    entered.current = null;
    column.focus({ preventScroll: true });
  });
  return useStableCallback((id: string) => {
    entered.current = id;
  });
}

/** What only this package can read, as the live hook takes it. */
function useOwn(
  page: Page,
  askRow: OhboxLiveOwn["askRow"],
  pickTags: OhboxLiveOwn["pickTags"],
): OhboxLiveOwn {
  const { host, route, commands, plan } = useFrame();
  const t = useText("ohbox");
  const screening = useText("screening");
  const session = useText("session");
  const tag = useText("tag");
  const markAll = useText("markAll");
  const words = useMemo(
    () => wordsOver({ ohbox: t, screening, session, tag, markAll }),
    [t, screening, session, tag, markAll],
  );
  const ownAddresses = useOwnAddresses();
  /* The Screener's one model, as the ground stands it: who waits at the door, without a sender on their way out. */
  const screener = useScreener();
  const waiting = screener.waiting.filter((w) => !screener.isExiting(w.id));
  const firstRun = host.wires.firstRun;
  /* The reading column's scroller, read at the moment it is asked: the reader's sheet mounts and goes under it. */
  const readColRef = useMemo<RefObject<HTMLDivElement | null>>(
    () => ({
      get current() {
        return page()?.querySelector<HTMLDivElement>(SEATED.reading) ?? null;
      },
    }),
    [page],
  );
  const anchors = useMemo(
    () => ({
      pickTag: () => page()?.querySelector<HTMLElement>(`${SEATED.list} .ob-foot`) ?? null,
      row: (id: string) => {
        const doc = page();
        return doc === null ? null : rowOf(doc, id);
      },
    }),
    [page],
  );
  /* An answer from a row is the one composer's (Reply toggles its editor on the letter, Forward asks first, Draft
     reply asks the drafter), as the reader's are. */
  const composer = useComposer();
  const { replyTo } = useWriting();
  const answer = useStableCallback((how: ListAnswer, m: EngineMessage) =>
    answerThrough({ ...answersOf(composer), replyTo }, how, m),
  );
  return {
    t,
    words,
    shortcuts: useText("shortcuts"),
    cursor: useText("cursor"),
    zone: useTimeZone(),
    rowSelector: "[data-id]",
    avatarSelector: ".oh-row-face",
    anchors,
    readColRef,
    at: { reading: SEATED.reading, openRow: `${SEATED.list} .oh-row[data-open]` },
    doorbell: {
      initials: waiting.map((w) => w.initial),
      hues: waiting.map((w) => avatarHue(w.from.address)),
      count: screener.waitingCount,
      settled: screener.queueSettled,
      storeSettled: screener.storeSettled,
    },
    setupHref: firstRun === NONE ? undefined : firstRun.setupHref,
    answer,
    replyAll: (m) => hasReplyAll(m, ownAddresses),
    pickTags,
    onRowEntered: useKeyboardToEnteredLetter(route.open, page, plan.columns === 1),
    askRow,
  };
}

function useLocatedLetter(arrival: string | null, open: string | null): string | null {
  const [located, setLocated] = useState<string | null>(null);
  // Keep the wash on the arriving letter after the Ohbox takes the entry, until another letter is shown.
  useLayoutEffect(() => {
    setLocated((current) => arrival ?? (current === open ? current : null));
  }, [arrival, open]);
  return located;
}

function useOhboxTagOffers(live: ReturnType<typeof useOhboxLive>): void {
  const { tags, model } = live;
  const palette = useText("palette");
  const selected = model.selected;
  usePaletteOffers(
    "mail",
    tags.map((tag) => ({
      id: `mail.tag.${tag.id}`,
      label: palette("tagToggle", { name: tag.name }),
      icon: "tags",
      disabled: selected === null,
      run: () => {
        if (selected !== null) live.toggleTag(selected.id, tag.id, !selected.labels.includes(tag.id));
      },
    })),
    true,
  );
}

function useOhboxListFocus(
  model: ReturnType<typeof useOhboxLive>["model"],
  page: ReturnType<typeof usePage>,
) {
  const scroller = model.listScrollerRef;
  useLayoutEffect(() => page.from(scroller), [page, scroller]);
  /* The selection's bar stands at the list's foot while rows are picked: on a phone the frame draws no dock over it. */
  useSelectionBar(model.pickedRowCount > 0);
  useRowFocusFollow(model.selected?.id ?? null, page.read);
  useListKeepsKeyboard(page.read);
  useRailDrag({ ...model.drag, rows: `${SEATED.list} .oh-row[data-id]`, page: page.read });
}

type TagAsk = { ids: string[]; anchor: HTMLElement | null; point?: Parameters<OhboxLiveOwn["pickTags"]>[2] };

export function OhboxSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const { host, plan, commands, route } = useFrame();
  const storageCard = host.features.storageCard;
  const page = usePage();
  const [rowAsk, setRowAsk] = useState<RowAsk | null>(null);
  const [tagAsk, setTagAsk] = useState<TagAsk | null>(null);
  const own = useOwn(page.read, setRowAsk, (ids, anchor, point) => setTagAsk({ ids, anchor, point }));
  const args = usePlaceLiveArgs();
  const live = useOhboxLive(args, own, useResumingReader()?.square ?? null);
  const located = useLocatedLetter(args.entered.letter, route.open);
  const { model, replacing, now, absoluteTime, flipTime, tags, mail, notOrganizing, sentLabelOf } = live;
  if (replacing && rowAsk !== null) setRowAsk(null);
  if (replacing && tagAsk !== null) setTagAsk(null);
  useOhboxTagOffers(live);
  useSwitchEnded(route, live.onScreen);
  useOhboxListFocus(model, page);
  const { doorbell, setupHref } = own;
  /* The ground's one Pull new mail: the list under a finger and "Ohbox actions" ring the same flight as the foot. */
  const pull = usePull();
  const beside: OhboxBeside = useMemo(
    () => ({
      words: {
        name: senderName,
        address: (m) => rowAddress(m),
        stamp: (m) => {
          const s = rowStamp(m, now, absoluteTime);
          return {
            when: s.time,
            ...(s.timeTitle ? { title: s.timeTitle } : {}),
            ...(s.timeSpoken ? { spoken: s.timeSpoken } : {}),
          };
        },
        sentTo: (m) => sentLabelOf(m),
        mailbox: (a) => displayAddress(a),
        tag: (m) => {
          const first = tagsOfMessage(m, tags)[0];
          return first ? { name: first.name, hue: tagHue(first.hue) } : null;
        },
      },
      mail,
      doorbell: { count: doorbell.count, settled: doorbell.settled },
      notOrganizing,
      first: storageCard === NONE ? null : storageCard.render(),
      pull: pull === null ? NONE : { busy: pull.pulling, run: pull.pull },
      keysShown: plan.pointer !== "coarse",
      askRow: setRowAsk,
      canDelete: (id) => host.engine.verbRead()?.get<EngineMessage>("message", id) != null,
      flipTime,
      located,
      go: {
        screener: () => commands.go({ place: "screener" }),
        history: () => commands.go({ place: "history" }),
        mailboxes: () => commands.go({ place: "settings", sub: "mailboxes" }),
        /* The web's setup page is an address: the empty Ohbox's way on is a link to it. A window has none. */
        ...(setupHref ? { mailboxesHref: setupHref } : {}),
        /* The first run again, for one mailbox nobody agreed to organize. */
        organize: (mailboxId) =>
          commands.go({
            place: "ohbox",
            stage: { id: "firstRun", words: { how: "again", mailbox: mailboxId } },
          }),
      },
    }),
    [
      now,
      absoluteTime,
      sentLabelOf,
      tags,
      mail,
      doorbell.count,
      doorbell.settled,
      notOrganizing,
      storageCard,
      host.engine,
      plan.pointer,
      flipTime,
      located,
      commands,
      setupHref,
      pull,
    ],
  );
  return (
    <OhboxAbove model={model} beside={beside}>
      {children}
      <OhboxRowAsk ask={replacing ? null : rowAsk} row={own.anchors.row} onClose={() => setRowAsk(null)} />
      {!replacing && tagAsk ? (
        <OhboxTagPicker
          ask={tagAsk}
          tags={tags}
          toggle={live.bulkToggleTag}
          onClose={() => setTagAsk(null)}
        />
      ) : null}
    </OhboxAbove>
  );
}

function OhboxTagPicker({
  ask,
  tags,
  toggle,
  onClose,
}: {
  ask: TagAsk;
  tags: readonly TagEntity[];
  toggle: ReturnType<typeof useOhboxLive>["bulkToggleTag"];
  onClose: () => void;
}) {
  const { host } = useFrame();
  const t = useText("tag");
  const press = usePress();
  const mailboxes = useMailboxFacts();
  const read = host.engine.verbRead();
  const targets = ask.ids.map((id) => read?.get<EngineMessage>("message", id));
  const assigned = tags
    .filter(({ id }) => targets.every((message) => message?.labels?.includes(id)))
    .map(({ id }) => id);
  const target = targets.length === 1 ? targets[0] : undefined;
  const canCreate =
    target &&
    !mailboxes?.some(({ id, organizerRole }) => id === target.mailboxId && organizerRole === "reader");
  return (
    <TagPicker
      anchor={ask.anchor}
      point={ask.point}
      tags={tags}
      assigned={assigned}
      onToggle={(id, assigned) => toggle(ask.ids, id, assigned)}
      onCreate={
        canCreate
          ? (name) => {
              onClose();
              void press.mutateAndReport(
                {
                  kind: "tag_assign",
                  messageId: target.id,
                  tagId: crypto.randomUUID(),
                  assigned: true,
                  createName: name,
                },
                t("toastTagged", { name }),
              );
            }
          : undefined
      }
      onClose={onClose}
    />
  );
}

/** The composer's answering doors alone: the seat hands no more of the record on. */
function answersOf(c: Omit<ComposerAnswers, "replyTo">): Omit<ComposerAnswers, "replyTo"> {
  return {
    toggleReply: c.toggleReply,
    openForward: c.openForward,
    openReply: c.openReply,
    replyAll: c.replyAll,
    draftReply: c.draftReply,
  };
}
