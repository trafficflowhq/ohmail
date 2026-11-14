/**
 * THE PILES' LIST: one view, Triage, three piles. The switch with its counts heads each (the rail keeps all three); Answer
 * Later carries the Reply Run (`f`); a Resurface row says when it is back and carries Done. An empty pile says so
 * once, in its list. A press opens the letter in the reader's column; the row the list's walk stands on is marked.
 */
import { useRef } from "react";
import { useListWindow } from "@ohmail/app-logic/lists";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { usePilesModel, type PileId, type PileRow, type PilesModel } from "@ohmail/app-logic/piles";
import { Button, Empty, Seg } from "@ohmail/ui/base";
import { ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { backStamp } from "./words.js";

function PileItem({
  row,
  index,
  model,
  tl,
  locale,
}: {
  row: PileRow;
  index: number;
  model: PilesModel;
  tl: Text;
  locale: string;
}) {
  const m = row.message;
  const who = m ? { name: m.from.name?.trim() || m.from.address, address: m.from.address } : null;
  const back = row.entry.resurfaceAt ? backStamp(row.entry.resurfaceAt, tl, locale) : null;
  const name = who?.name ?? row.entry.title;
  const subject = m?.subject || row.entry.subtitle || row.entry.title;
  const open = m !== null && model.cursor === m.id;
  return (
    <Row
      who={name}
      address={who?.address}
      people={who ? [who] : []}
      subject={subject}
      preview={row.entry.preview ?? m?.snippet ?? undefined}
      when={back ? tl("row.resurfaces", { when: back }) : m?.date ? model.stamp(m.date) : undefined}
      unread={m?.unread}
      open={open}
      own={
        model.pile === "resurface" && m
          ? { label: tl("row.done"), icon: "check", onPress: () => model.done(row) }
          : undefined
      }
      onOpen={m ? () => model.open(row) : undefined}
      listing={{ name: `${name}: ${subject}`, selected: open, stop: open }}
      mark={{ id: row.key, index }}
    />
  );
}

export function PilesList({ plan }: PaneProps) {
  const model = usePilesModel();
  return <PileColumn key={model.pile} plan={plan} model={model} />;
}

function PileColumn({ plan, model }: { plan: PaneProps["plan"]; model: PilesModel }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { cursor } = model;
  const win = useListWindow({
    scrollerRef: scroller,
    count: model.rows.length,
    cursor:
      cursor === null ? undefined : { id: cursor, index: model.rows.findIndex((row) => row.key === cursor) },
  });
  const { commands } = useFrame();
  const t = useText(model.pile);
  const triage = useText("triage");
  const tl = useText("later");
  const tp = useText("parked");
  const tr = useText("resurface");
  const locale = useLocale();
  const runs = model.run.canStart;
  /* The list is inside the key provider even when its model is supplied above the frame. */
  useKeyBindings(
    model.pile === "later"
      ? [
          {
            chord: "f",
            group: "message",
            label: triage("keyReplyRun"),
            disabled: !runs,
            run: model.run.start,
          },
        ]
      : [],
  );
  /* Each pile's number is part of its segment's words, a pile with nothing as 0; while the mailbox is not settled
     the switch says the piles' names alone. */
  const segment = (name: string, count: number) =>
    model.mayState ? tl("switch.segment", { name, count }) : name;
  const options: { value: PileId; label: string }[] = [
    { value: "later", label: segment(tl("title"), model.counts.later) },
    { value: "parked", label: segment(tp("title"), model.counts.parked) },
    { value: "resurface", label: segment(tr("title"), model.counts.resurface) },
  ];
  return (
    <ListColumn
      plan={plan}
      cursor={model.cursor}
      scrollerRef={scroller}
      manualScrollAnchor={win.end - win.start < model.rows.length}
      head={
        <ListHead
          title={triage("title")}
          aside={
            <>
              {runs ? (
                <Button kind="two" size="s" icon="spark" keyHint="f" onPress={model.run.start}>
                  {tl("run.start")}
                </Button>
              ) : null}
              <ListMenu label={triage("list.menu")} items={[]} />
            </>
          }
          below={
            <Seg
              label={tl("switch.label")}
              options={options}
              value={model.pile}
              onChange={(pile) => commands.go({ place: pile })}
            />
          }
        />
      }
    >
      {model.mayState && model.rows.length === 0 ? (
        <Empty label={t("empty")} />
      ) : (
        <Rows label={t("title")}>
          <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
          {model.rows.slice(win.start, win.end).map((row, offset) => (
            <PileItem
              key={row.key}
              row={row}
              index={win.start + offset}
              model={model}
              tl={tl}
              locale={locale}
            />
          ))}
          {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        </Rows>
      )}
    </ListColumn>
  );
}
