/**
 * A STREAM PLACE'S LIST: the head with its count of new items and the list's menu (Mark all read), one row per item,
 * and the line "Seen up to here", with when it was drawn, between what is new since the last visit and what is not. A row draws no unread dot: newness is
 * the place above the line. A press opens the item in the stream. On a phone's width the place is the stream itself.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useContext, useRef, type ReactNode } from "react";
import { useZoneNav } from "@ohmail/app-logic/keys";
import { useEngineOrNull } from "@ohmail/app-logic/engine";
import { PileNoteContext } from "@ohmail/app-logic/lists/pile-note";
import { useListWindow } from "@ohmail/app-logic/lists";
import { lineStampOf, presentsUnread, useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { Badge } from "@ohmail/ui";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { NONE } from "../host/index.js";
import type { PaneProps } from "../frame/contract.js";
import { useMailboxWord } from "../frame/room.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { FilingChip, FilingChoiceContext, type FilingChipData } from "./FilingChip.js";
import { PileNote } from "./PileNote.js";
import { StreamColumn } from "./StreamColumn.js";
import { useStreamKeys } from "./keys.js";
import { senderOf, stampOf, useStreamText } from "./words.js";
import "./stream.css";

function ItemRow({
  m,
  index,
  position,
  model,
  t,
  locale,
  delivery,
}: {
  m: EngineMessage;
  index: number;
  position: { at: number; of: number };
  model: StreamModel;
  t: Text;
  locale: string;
  delivery?: { label: string; title: string };
}) {
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale);
  const selected = (model.openId ?? model.standingId) === m.id;
  return (
    <Row
      who={who.name}
      address={who.address}
      people={[who]}
      subject={m.subject || ""}
      preview={m.snippet ?? undefined}
      when={m.date ? model.stamp(m.date) : ""}
      whenTitle={stamp.full}
      amount={model.place === "receipts" ? m.amount : undefined}
      file={m.hasAttachments ? t("item.file") : undefined}
      open={model.openId === m.id}
      stream
      unread={presentsUnread(m)}
      onOpen={() => model.open(m.id, false, true)}
      onKeyboardOpen={() => model.open(m.id, true, true)}
      tag={
        delivery ? (
          <Badge variant="place" title={delivery.title}>
            {delivery.label}
          </Badge>
        ) : undefined
      }
      listing={{
        name: m.subject ? `${who.name}: ${m.subject}` : who.name,
        selected,
        stop: selected,
        place: position,
        spoken: [delivery?.title, t("item.keyboardOpen")].filter(Boolean).join(". "),
      }}
      mark={{ id: m.id, index, unseen: m.unread }}
    />
  );
}

export function StreamList({ plan, keysHere }: PaneProps) {
  const model = useStreamModel();
  const filingChoice = useContext(FilingChoiceContext);
  const engine = useEngineOrNull();
  const filingChip =
    model.place === "news" && filingChoice
      ? engine?.read().get<FilingChipData>("view_meta", "reads_ai_chip")
      : undefined;
  const t = useStreamText(model.place);
  const news = useText("reads");
  const locale = useLocale();
  const mailboxWord = useMailboxWord();
  const place = useFrame().host.features.places[model.place];
  const labelsMailboxes = place !== NONE && place.rowMailboxLabels === true;
  const message = useText("message");
  const rowsRef = useRef<HTMLDivElement>(null);
  /* One index space: the new rows, the line, the seen rows. The line is an item with its own measured height. */
  const fresh = model.freshCount;
  const seenCount = model.items.length - fresh;
  const line = model.lineShown && seenCount > 0 ? 1 : 0;
  const after = filingChip ? model.items.slice(0, fresh).findIndex((m) => m.id === filingChip.afterId) : -1;
  const chip = after >= 0 ? 1 : 0;
  const lineAt = fresh + chip;
  const win = useListWindow({ scrollerRef: rowsRef, count: model.items.length + line + chip });
  useStreamKeys(keysHere, model.scroller, model);
  useZoneNav(useText("shortcuts"), { listFocusSelector: '.pl-list [role="option"][aria-selected="true"]' });
  const lineStamp = model.lineAt ? lineStampOf(model.lineAt, new Date(), locale) || undefined : undefined;
  /* The rows above the line, the line where it is in the window, the rows below it: each run its own list. */
  const above: ReactNode[] = [];
  const below: ReactNode[] = [];
  let lineNode: ReactNode = null;
  for (let w = win.start; w < win.end; w++) {
    if (filingChip && filingChoice && chip === 1 && w === after + 1) {
      above.push(
        <div className="st-filing-chip" role="presentation" key="filing" data-index={w}>
          <FilingChip example={filingChip} {...filingChoice} />
        </div>,
      );
      continue;
    }
    if (line === 1 && w === lineAt) {
      lineNode = (
        <div data-index={w}>
          <GroupHeading count={lineStamp}>{t("waterline.label")}</GroupHeading>
        </div>
      );
      continue;
    }
    const past = line === 1 && w > lineAt;
    const index = w - (chip === 1 && w > after ? 1 : 0) - (past ? 1 : 0);
    const m = model.items[index];
    if (m) {
      const position = past
        ? { at: index - fresh + 1, of: seenCount }
        : { at: index + 1, of: line === 1 ? fresh : model.items.length };
      const mailbox = labelsMailboxes ? mailboxWord(m.mailboxId) : null;
      const delivery = mailbox
        ? { label: mailbox, title: message("deliveredToTitle", { label: mailbox }) }
        : undefined;
      (past ? below : above).push(
        <ItemRow
          key={m.id}
          m={m}
          index={w}
          position={position}
          model={model}
          t={t}
          locale={locale}
          delivery={delivery}
        />,
      );
    }
  }
  const head = <StreamHead model={model} dock={plan.rail === "dock"} />;
  /* An empty stream's list says so, as the reference draws it; its reading column says All read. */
  const empty = model.mayState && model.items.length === 0 ? <Empty label={t("stream.empty")} /> : null;
  /* On a phone the place is the stream itself, under its head. */
  if (plan.device === "phone")
    return empty === null ? (
      <div className="pl-list st-phone-list" data-stream-phone-list="" data-cursor-tint="">
        {head}
        <div className="pl-fill">
          <StreamColumn phone keysHere={keysHere} />
        </div>
      </div>
    ) : (
      <ListColumn plan={plan} label={t("list.label")} head={head}>
        {empty}
      </ListColumn>
    );
  return (
    <ListColumn
      plan={plan}
      label={t("list.label")}
      cursorTint
      scrollerRef={rowsRef}
      cursor={model.openId}
      head={head}
    >
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {above.length > 0 ? <Rows label={t("list.label")}>{above}</Rows> : null}
      {lineNode}
      {below.length > 0 ? <Rows label={t("waterline.label")}>{below}</Rows> : null}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
      {model.place === "news" && model.mayState && model.items.length > 0 ? (
        <p className="st-read-rule">{news("tail")}</p>
      ) : null}
      {empty}
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
              items={
                model.mayState && clear === undefined
                  ? []
                  : [
                      {
                        label: t("markAll.label"),
                        spoken: model.mayState ? clear : undefined,
                        icon: "read",
                        note: model.mayState && unread > 0 ? unread.toLocaleString(locale) : undefined,
                        disabled: !model.mayState,
                        onPress: model.markAllRead,
                      },
                    ]
              }
            />
          </>
        }
      />
      {pileNote ? <PileNote offer={pileNote} /> : null}
    </>
  );
}
