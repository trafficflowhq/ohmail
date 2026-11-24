/**
 * A STREAM PLACE'S LIST: the head with its count of new items and the list's menu (Mark all read), one row per item,
 * and the line "Seen up to here", with when it was drawn, between what is new since the last visit and what is not. A row draws no unread dot: newness is
 * the place above the line. A press opens the item in the stream. On a phone's width the place is the stream itself.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useContext, useRef, useState, type RefObject, type ReactNode } from "react";
import { useZoneNav } from "@ohmail/app-logic/keys";
import { PileNoteContext } from "@ohmail/app-logic/lists/pile-note";
import { useListWindow } from "@ohmail/app-logic/lists";
import { lineStampOf, presentsUnread, useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { sentRowRecipient } from "@ohmail/app-logic/text/format";
import { useSentLabel } from "@ohmail/app-logic/text/row-copy";
import { Button, Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { NONE } from "../host/index.js";
import type { PaneProps } from "../frame/contract.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useRowPeople } from "../place-list/people.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { PileNote } from "./PileNote.js";
import { StreamBackToTop } from "./StreamBackToTop.js";
import { StreamColumn } from "./StreamColumn.js";
import { StreamReplyContext } from "./StreamAbove.js";
import { useStreamKeys } from "./keys.js";
import { receiptAmount, senderOf, stampOf, useStreamText } from "./words.js";
import "./stream.css";

import { MailSelectionFoot } from "../place-list/MailSelectionFoot.js";
import { useRowContact, type RowContact } from "../place-list/use-row-contact.js";
import { useRowSelection, type RowSelection } from "../place-list/use-row-selection.js";

function ItemRow({
  m,
  index,
  position,
  model,
  t,
  locale,
  answered,
  sentLabel,
  rowPeople,
  selection,
  contact,
}: {
  m: EngineMessage;
  index: number;
  position: { at: number; of: number };
  model: StreamModel;
  t: Text;
  locale: string;
  selection: RowSelection;
  contact: RowContact;
  answered?: EngineMessage;
  sentLabel: ReturnType<typeof useSentLabel>;
  rowPeople: ReturnType<typeof useRowPeople>;
}) {
  const message = useText("message");
  const who = senderOf(m);
  const unread = presentsUnread(m);
  const sent = answered && sentLabel(answered);
  const recipient = sent && answered ? sentRowRecipient(answered) : null;
  const shown = sent && answered ? answered : m;
  const byline = sent?.label ?? who.name;
  const stamp = stampOf(shown.date, t, locale);
  const pick = selection.rowProps(m.id);
  const selected = (model.openId ?? model.standingId) === m.id;
  return (
    <Row
      {...pick}
      {...(sent ? {} : contact.rowProps(m.from, m.id))}
      who={byline}
      address={sent ? undefined : who.address}
      {...rowPeople(m, recipient ?? who)}
      subject={m.subject || ""}
      preview={shown.snippet ?? undefined}
      when={shown.date ? model.stamp(shown.date) : ""}
      whenTitle={stamp.full}
      amount={model.place === "receipts" ? receiptAmount(m, model.textOf(m.id)) : undefined}
      file={m.hasAttachments ? t("item.file") : undefined}
      open={selected}
      cursor={selected && !model.openId}
      stream
      unread={unread}
      onOpen={() => model.open(m.id, false, true)}
      onKeyboardOpen={() => model.open(m.id, true, true)}
      listing={{
        name: m.subject ? `${byline}: ${m.subject}` : byline,
        selected: selection.ids.length ? pick.picked === true : selected,
        stop: selected,
        place: position,
        spoken: [t("item.keyboardOpen"), unread ? message("rowUnread") : null].filter(Boolean).join(". "),
      }}
      mark={{ id: m.id, index, unseen: m.unread }}
    />
  );
}

export function StreamList({ plan, keysHere }: PaneProps) {
  const model = useStreamModel();
  const t = useStreamText(model.place);
  useStreamKeys(keysHere, model.scroller, model);
  useZoneNav(useText("shortcuts"), { listFocusSelector: '.pl-list [role="option"][aria-selected="true"]' });
  const selection = useRowSelection(model.items, model.place);
  const head = <StreamHead model={model} dock={plan.rail === "dock"} />;
  /* An empty stream's list says so, as the reference draws it; its reading column says All read. */
  const empty = model.mayState && model.items.length === 0 ? <Empty label={t("stream.empty")} /> : null;
  /* On a phone the place is the stream itself, under its head. */
  if (plan.device === "phone")
    return empty === null ? (
      <div className="pl-list st-phone-list" data-stream-phone-list="">
        {head}
        <div className="pl-fill">
          <StreamColumn phone keysHere={keysHere} selection={selection} />
        </div>
        <MailSelectionFoot selection={selection} verbs={model.verbs} />
      </div>
    ) : (
      <ListColumn plan={plan} label={t("list.label")} head={head}>
        {empty}
      </ListColumn>
    );
  return (
    <StreamRowsList
      plan={plan}
      model={model}
      head={head}
      empty={empty}
      selection={selection}
      keysHere={keysHere}
    />
  );
}

function useRowsWindow(model: StreamModel, rowsRef: RefObject<HTMLDivElement | null>, line: number) {
  const cursor = model.openId === null ? -1 : model.items.findIndex((item) => item.id === model.openId);
  const slot = cursor + (line === 1 && cursor >= model.freshCount ? 1 : 0);
  return useListWindow({
    scrollerRef: rowsRef,
    count: model.items.length + line,
    cursor: model.openId === null ? undefined : { id: model.openId, index: slot },
  });
}

interface StreamRowsListProps {
  plan: PaneProps["plan"];
  model: StreamModel;
  head: ReactNode;
  empty: ReactNode;
  keysHere: boolean;
  selection: RowSelection;
}

/** Window the new rows, waterline and seen rows together, then render each run as its own list. */
function StreamRowsList({ plan, model, head, empty, keysHere, selection }: StreamRowsListProps) {
  const contact = useRowContact();
  const reply = useContext(StreamReplyContext);
  const sentLabel = useSentLabel(useText("ohbox"));
  const rowPeople = useRowPeople();
  const t = useStreamText(model.place);
  const locale = useLocale();
  const { host, commands } = useFrame();
  const rowsRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    rowsRef.current = node;
    setScroller(node);
  }, []);
  const fresh = model.freshCount;
  const seenCount = model.items.length - fresh;
  const line = model.lineShown && seenCount > 0 ? 1 : 0;
  const win = useRowsWindow(model, rowsRef, line);
  const lineStamp = model.lineAt ? lineStampOf(model.lineAt, new Date(), locale) || undefined : undefined;
  const above: ReactNode[] = [];
  const below: ReactNode[] = [];
  let lineNode: ReactNode = null;
  for (let w = win.start; w < win.end; w++) {
    if (line === 1 && w === fresh) {
      lineNode = (
        <div data-index={w}>
          <GroupHeading count={lineStamp}>{t("waterline.label")}</GroupHeading>
        </div>
      );
      continue;
    }
    const past = line === 1 && w > fresh;
    const index = w - (past ? 1 : 0);
    const m = model.items[index];
    if (m) {
      const position = past
        ? { at: index - fresh + 1, of: seenCount }
        : { at: index + 1, of: line === 1 ? fresh : model.items.length };
      (past ? below : above).push(
        <ItemRow
          key={m.id}
          m={m}
          index={w}
          position={position}
          model={model}
          t={t}
          locale={locale}
          answered={reply?.conversations.get(m.id)?.messages.at(-1)}
          sentLabel={sentLabel}
          rowPeople={rowPeople}
          selection={selection}
          contact={contact}
        />,
      );
    }
  }
  return (
    <ListColumn
      plan={plan}
      label={t("list.label")}
      scrollerRef={attach}
      cursor={model.openId}
      head={head}
      foot={
        <>
          <div data-stream-list-top="">
            <StreamBackToTop
              scroller={scroller}
              keysHere={keysHere}
              onPress={() => scroller?.scrollTo({ top: 0 })}
              lifted={selection.active}
            />
          </div>
          <MailSelectionFoot selection={selection} verbs={model.verbs} />
        </>
      }
    >
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {above.length > 0 ? (
        <Rows label={t("list.label")} many>
          {above}
        </Rows>
      ) : null}
      {lineNode}
      {below.length > 0 ? (
        <Rows label={t("waterline.label")} many>
          {below}
        </Rows>
      ) : null}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
      {model.place === "receipts" &&
      model.items.length > 0 &&
      host.features.places.search !== NONE &&
      win.end === model.items.length + line ? (
        <div className="st-search-tail">
          <Button kind="quiet" size="s" icon="search" onPress={() => commands.go({ place: "search" })}>
            {t("search.older")}
          </Button>
        </div>
      ) : null}
      {empty}
      {contact.card}
    </ListColumn>
  );
}

function StreamHead({ model, dock }: { model: StreamModel; dock: boolean }) {
  const pileNote = useContext(PileNoteContext);
  const since = useText("stream");
  const compact = useText("ohbox");
  const markAll = useText("markAll");
  const t = useStreamText(model.place);
  const locale = useLocale();
  const fresh = model.freshCount;
  const unread = model.items.filter((m) => m.unread).length;
  const clear =
    unread > 0
      ? markAll("aria", { count: unread })
      : model.lineShown && fresh > 0
        ? markAll("ariaFresh", { count: fresh })
        : undefined;
  return (
    <>
      <ListHead
        title={t("title")}
        hot={model.mayState && model.newCount > 0}
        lead={dock ? <ProductSwitch kind="round" /> : undefined}
        asideClassName="st-head-end"
        aside={
          <>
            {model.mayState ? (
              <span className={model.newCount > 0 ? "oh-listhead-count" : undefined}>
                <span className="oh-vh">{since("newSince", { count: model.newCount })}</span>
                {model.newCount > 0 ? (
                  <span aria-hidden="true">{compact("newSince", { count: model.newCount })}</span>
                ) : null}
              </span>
            ) : null}
            <ListMenu
              label={t("list.menu")}
              mail
              items={[
                {
                  label: t("markAll.label"),
                  spoken: model.mayState ? clear : undefined,
                  icon: "read",
                  note: model.mayState && unread > 0 ? unread.toLocaleString(locale) : undefined,
                  disabled: !model.mayState || clear === undefined,
                  onPress: model.markAllRead,
                },
              ]}
            />
          </>
        }
      />
      {pileNote ? <PileNote offer={pileNote} pileLabel={t("title")} /> : null}
    </>
  );
}
