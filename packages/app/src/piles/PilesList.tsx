/**
 * THE PILES' LIST: one view, Triage, three piles. The switch with its counts heads each (the rail keeps all three); Answer
 * Later carries the Reply Run (`f`); a Resurface row says when it is back and carries Done. An empty pile says so
 * once, in its list. A press opens the letter in the reader's column.
 */
import { usePilesModel, type PileId, type PileRow, type PilesModel } from "@ohmail/app-logic/piles";
import { Button, Empty, Seg } from "@ohmail/ui/base";
import { ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { useState } from "react";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { useRunKey } from "./keys.js";
import { backStamp } from "./words.js";

function PileItem({ row, model, tl, locale }: { row: PileRow; model: PilesModel; tl: Text; locale: string }) {
  const m = row.message;
  const who = m ? { name: m.from.name?.trim() || m.from.address, address: m.from.address } : null;
  const back = row.entry.resurfaceAt ? backStamp(row.entry.resurfaceAt, tl, locale) : null;
  return (
    <Row
      who={who?.name ?? row.entry.title}
      address={who?.address}
      people={who ? [who] : []}
      subject={m?.subject || row.entry.subtitle || row.entry.title}
      preview={row.entry.preview ?? m?.snippet ?? undefined}
      when={back ? tl("row.resurfaces", { when: back }) : m?.date ? model.stamp(m.date) : undefined}
      unread={m?.unread}
      open={m !== null && model.openId === m.id}
      own={
        model.pile === "resurface" && m
          ? { label: tl("row.done"), icon: "check", onPress: () => model.done(row) }
          : undefined
      }
      onOpen={m ? () => model.open(row) : undefined}
      mark={{ id: row.key }}
    />
  );
}

export function PilesList({ plan, keysHere }: PaneProps) {
  const model = usePilesModel();
  const { commands } = useFrame();
  const t = useText(model.pile);
  const triage = useText("triage");
  const tl = useText("later");
  const tp = useText("parked");
  const tr = useText("resurface");
  const locale = useLocale();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const runs = model.pile === "later" && model.mayState && model.counts.later > 0;
  useRunKey(keysHere, root, runs ? model.run.start : null);
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
      rootRef={setRoot}
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
        <Rows>
          {model.rows.map((row) => (
            <PileItem key={row.key} row={row} model={model} tl={tl} locale={locale} />
          ))}
        </Rows>
      )}
    </ListColumn>
  );
}
