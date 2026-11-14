/**
 * A STREAM PLACE'S LIST: the head with its count of new items and the list's menu (Mark all read), one row per item,
 * and the line "Seen up to here", with when it was drawn, between what is new since the last visit and what is not. A row draws no unread dot: newness is
 * the place above the line. A press opens the item in the stream. On a phone's width the place is the stream itself.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useContext, useRef, type ReactNode } from "react";
import { PileNoteContext } from "@ohmail/app-logic/lists/pile-note";
import { useListWindow } from "@ohmail/app-logic/lists";
import { lineStampOf, useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { PileNote } from "./PileNote.js";
import { StreamColumn } from "./StreamColumn.js";
import { useStreamKeys } from "./keys.js";
import { senderOf, stampOf, useStreamText } from "./words.js";
import "./stream.css";

function ItemRow({
  m,
  index,
  model,
  t,
  locale,
}: {
  m: EngineMessage;
  index: number;
  model: StreamModel;
  t: Text;
  locale: string;
}) {
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale);
  return (
    <Row
      who={who.name}
      address={who.address}
      people={[who]}
      subject={m.subject || ""}
      preview={m.snippet ?? undefined}
      when={m.date ? model.stamp(m.date) : ""}
      whenTitle={stamp.full}
      file={m.hasAttachments ? t("item.file") : undefined}
      open={model.openId === m.id}
      onOpen={() => model.open(m.id)}
      mark={{ id: m.id, index }}
    />
  );
}

export function StreamList({ plan, keysHere }: PaneProps) {
  const model = useStreamModel();
  const pileNote = useContext(PileNoteContext);
  const t = useStreamText(model.place);
  /* What is new since the last visit says so in the released stream's one sentence (the catalogue's waterline key): a
     count that says "new" alone, beside a menu counting the unread, is the "2 new" beside 3 unread the word guard ends. */
  const since = useText("stream");
  const locale = useLocale();
  const rowsRef = useRef<HTMLDivElement>(null);
  /* One index space: the new rows, the line, the seen rows. The line is an item with its own measured height. */
  const fresh = model.freshCount;
  const seenCount = model.items.length - fresh;
  const line = model.lineShown && seenCount > 0 ? 1 : 0;
  const win = useListWindow({ scrollerRef: rowsRef, count: model.items.length + line });
  useStreamKeys(keysHere, model.scroller, model);
  const unread = model.items.filter((m) => m.unread).length;
  const lineStamp = model.lineAt ? lineStampOf(model.lineAt, new Date(), locale) || undefined : undefined;
  /* The rows above the line, the line where it is in the window, the rows below it: each run its own list. */
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
    const m = model.items[line === 1 && w > fresh ? w - 1 : w];
    if (m)
      (w < fresh ? above : below).push(
        <ItemRow key={m.id} m={m} index={w} model={model} t={t} locale={locale} />,
      );
  }
  const head = (
    <>
      <ListHead
        title={t("title")}
        hot={model.mayState && model.newCount > 0}
        count={model.mayState ? since("newSince", { count: model.newCount }) : undefined}
        aside={
          <ListMenu
            label={t("list.menu")}
            items={[
              {
                label: t("markAll.label"),
                icon: "read",
                note: model.mayState && unread > 0 ? String(unread) : undefined,
                /* Rows above the line with nothing unread: the press moves the line, as the released stream's. */
                disabled: !model.mayState || (unread === 0 && fresh === 0),
                onPress: model.markAllRead,
              },
            ]}
          />
        }
      />
      {pileNote ? <PileNote offer={pileNote} /> : null}
    </>
  );
  /* An empty stream's list says so, as the reference draws it; its reading column says All read. */
  const empty = model.mayState && model.items.length === 0 ? <Empty label={t("stream.empty")} /> : null;
  /* On a phone the place is the stream itself, under its head. */
  if (plan.device === "phone")
    return empty === null ? (
      <div className="pl-list">
        {head}
        <div className="pl-fill">
          <StreamColumn phone keysHere={false} />
        </div>
      </div>
    ) : (
      <ListColumn plan={plan} label={t("list.label")} head={head}>
        {empty}
      </ListColumn>
    );
  return (
    <ListColumn plan={plan} label={t("list.label")} scrollerRef={rowsRef} head={head}>
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {above.length > 0 ? <Rows>{above}</Rows> : null}
      {lineNode}
      {below.length > 0 ? <Rows>{below}</Rows> : null}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
      {empty}
    </ListColumn>
  );
}
