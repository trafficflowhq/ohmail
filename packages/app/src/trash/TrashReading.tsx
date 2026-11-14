/**
 * TRASH'S OWN READING COLUMN: its rows are not in the mirror, so the reader cannot draw them. A deleted letter stands
 * with Restore in its panel (where it goes is the row's record) and the read slot; a row of the mail server's Trash stands with its
 * text read on open and no verb at all. The letter is its plain text until the reader's own letter in place is here.
 */
import { useState } from "react";
import { useTrashModel } from "@ohmail/app-logic/trash";
import { RefusalLine } from "@ohmail/ui/base";
import { ActionPanel, BlankColumn, Message, MessageHead, ReadingHead, Sheet } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { useRestoreBinding, useTrashKeys } from "./keys.js";

export function TrashReading({ keysHere }: PaneProps) {
  const model = useTrashModel();
  const t = useText("trash");
  /* The panel and its read slot say the reader's own words: Actions; Mark unread, Mark read. */
  const tr = useText("reader");
  const row = model.openRow;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useRestoreBinding(true, t("restoreKey"), keysHere && row !== null ? () => model.restore(row) : undefined);
  useTrashKeys(keysHere, root, row === null ? null : { read: () => model.flipRead(row) });
  if (row !== null) {
    const who = row.from.name ?? row.from.address;
    const unread = model.unreadOf(row);
    return (
      <Sheet
        kind="reading"
        label={row.subject}
        scroller={setRoot}
        head={<ReadingHead subject={row.subject} people={[]} />}
        foot={
          <ActionPanel
            label={tr("panel")}
            items={[
              {
                id: "restore",
                label: t("restore"),
                icon: "history",
                kind: "ink" as const,
                rank: 0,
                keyHint: "⇧⌫",
                onPress: () => model.restore(row),
              },
              {
                id: "read",
                label: tr(unread ? "verb.markRead" : "verb.markUnread"),
                icon: unread ? "read" : "unread",
                apart: true,
                rank: 0,
                keyHint: "u",
                widest: tr("verb.markUnread"),
                hotIcon: unread,
                onPress: () => model.flipRead(row),
              },
            ]}
          />
        }
      >
        <Message
          head={
            <MessageHead
              sender={{ name: who, address: row.from.address }}
              stamp={{
                when: row.date === null ? "" : model.stamp(row.date),
                full: false,
                title: row.date ?? "",
              }}
            />
          }
        >
          {row.snippet ?? ""}
        </Message>
      </Sheet>
    );
  }
  const live = model.openLive;
  if (live !== null) {
    const who = live.from.name ?? live.from.address;
    const body = model.live.bodyFor(live);
    return (
      <Sheet
        kind="reading"
        label={live.subject}
        head={<ReadingHead subject={live.subject} people={[]} />}
        foot={<ActionPanel label={t("title")} items={[{ note: t("liveReadOnly"), keep: true }]} />}
      >
        <Message
          head={
            <MessageHead
              staticMetadata
              sender={{ name: who, address: live.from.address }}
              stamp={{ when: live.date ? model.stamp(live.date) : "", full: false, title: live.date ?? "" }}
            />
          }
        >
          {body.phase === "ready" ? (
            body.text
          ) : body.phase === "failed" ? (
            /* A text that could not be read is said so, with the one way to ask for it again: one more read. */
            <RefusalLine
              way={{ label: t("liveRetry"), onPress: () => model.live.openBody(live, { retry: true }) }}
            >
              {t("liveBodyFailed")}
            </RefusalLine>
          ) : (
            t("liveBodyLoading")
          )}
        </Message>
      </Sheet>
    );
  }
  if (model.gone) return <BlankColumn>{tr("goneShort")}</BlankColumn>;
  return <BlankColumn>{t(model.deletedEmpty ? "emptyTitle" : "title")}</BlankColumn>;
}
