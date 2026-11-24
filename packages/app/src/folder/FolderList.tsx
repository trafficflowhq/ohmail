/**
 * A FOLDER'S LIST: its name with the way to it (Folders, then each folder above it), how many letters it holds and the
 * list's menu, followed by its rows. A row's own menu moves its letter into another of the mailbox's
 * folders, where the seat hands the Move.
 * Empty, it says the folder holds nothing; gone from the mail server, it says so by name.
 */
import { useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { useFolderModel, type FolderMove } from "@ohmail/app-logic/folder";
import { folderLeafOf } from "@ohmail/app-logic/lists/folders";
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { ListHead, ListLine, MovePicker, type Way } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { routeOf } from "../frame/route.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useCursorWindow } from "../place-list/cursor-window.js";
import { useText } from "../text/index.js";

import { MailSelectionFoot } from "../place-list/MailSelectionFoot.js";
import { useRowContact } from "../place-list/use-row-contact.js";
import { useRowSelection } from "../place-list/use-row-selection.js";

export function FolderList({ plan }: PaneProps) {
  const model = useFolderModel();
  return <FolderColumn key={model.folder?.id ?? ""} plan={plan} model={model} />;
}

function FolderColumn({
  plan,
  model,
}: {
  plan: PaneProps["plan"];
  model: ReturnType<typeof useFolderModel>;
}) {
  const selection = useRowSelection(model.list.rows);
  const contact = useRowContact();
  const t = useText("folder");
  const moveWord = useText("ohbox");
  const [asked, setAsked] = useState<{ folderId: string; id: string; at: HTMLElement } | null>(null);
  const [batchMoveAt, setBatchMoveAt] = useState<HTMLElement | null>(null);
  const { move, older } = model;
  const folderId = model.folder?.id;
  const letter =
    asked && asked.folderId === folderId ? model.list.rows.find((m) => m.id === asked.id) : undefined;
  if (asked && (letter === undefined || move === null)) setAsked(null);
  const { rows, cursor } = model.list;
  const selected = rows.findIndex((m) => m.id === cursor);
  const { scroller, window } = useCursorWindow(rows.length, selected, cursor);
  const visible = rows.slice(window.start, window.end);
  return (
    <ListColumn
      foot={
        <MailSelectionFoot
          selection={selection}
          verbs={model.list.verbs}
          moveToFolder={move ? setBatchMoveAt : undefined}
        />
      }
      head={<FolderHead model={model} />}
      plan={plan}
      cursor={cursor}
      scrollerRef={scroller}
    >
      <div aria-hidden data-window-top="" style={{ height: window.padTop }} />
      {visible.length > 0 ? (
        <LetterRows
          verbs={model.list.verbs}
          folderMove
          selection={selection}
          contact={contact}
          label={model.path.at(-1) ?? t("way.all")}
          rows={visible}
          slice={{ index: window.start, first: window.start, total: rows.length }}
          cursor={cursor}
          press={model.list.press}
          stamp={model.stamp}
          file={t("row.file")}
          who={(m) => m.from.name ?? m.from.address}
          spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
          menuItems={
            move === null || folderId === undefined
              ? undefined
              : (m, { anchor }) => [
                  {
                    label: moveWord("actionMove"),
                    icon: "move",
                    onPress: () => setAsked({ folderId, id: m.id, at: anchor }),
                  },
                ]
          }
        />
      ) : null}
      {window.padBottom > 0 ? <div aria-hidden style={{ height: window.padBottom }} /> : null}
      {model.goneName !== null ? <Empty label={t("gone", { name: model.goneName })} /> : null}
      {model.empty ? <Empty label={t("emptyTitle")} /> : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
      <FolderOlder older={older} />
      {move !== null && asked !== null && letter !== undefined ? (
        <FolderMoveAsk
          move={move}
          source={asked.folderId}
          letters={[letter]}
          at={asked.at}
          close={() => setAsked(null)}
        />
      ) : null}
      {batchMoveAt?.isConnected && move && folderId && selection.pickedRows.length > 0 ? (
        <FolderMoveAsk
          move={move}
          source={folderId}
          letters={model.list.rows.filter(({ id }) => selection.ids.includes(id))}
          at={batchMoveAt}
          close={() => setBatchMoveAt(null)}
          onMoved={selection.clear}
        />
      ) : null}
      {contact.card}
    </ListColumn>
  );
}

function FolderOlder({ older }: { older: ReturnType<typeof useFolderModel>["older"] }) {
  const olderWords = useText("ohbox");
  return (
    <>
      {older?.available && !older.pending ? (
        older.error !== null ? (
          <RefusalLine way={{ label: olderWords("olderRetry"), onPress: older.loadMore }}>
            {olderWords("olderFailed", { reason: older.error })}
          </RefusalLine>
        ) : older.loading ? (
          <p role="status" aria-busy="true">
            {olderWords("olderLoading")}
          </p>
        ) : (
          <>
            {older.items.length > 0 ? (
              <ListLine fine>{olderWords("olderShowing", { count: older.items.length })}</ListLine>
            ) : null}
            {older.exhausted ? (
              <ListLine fine>{olderWords("olderEnd")}</ListLine>
            ) : (
              <Button kind="quiet" onPress={older.loadMore}>
                {olderWords("olderAction")}
              </Button>
            )}
          </>
        )
      ) : null}
    </>
  );
}

function FolderHead({ model }: { model: ReturnType<typeof useFolderModel> }) {
  const t = useText("folder");
  const leaf = model.path.at(-1) ?? "";
  /* Where it lives: Folders, then each folder above it. Folders opens the fold of every folder once the rail has
     one; until then it is said, not pressed. */
  const way: Way | undefined =
    model.folder !== null
      ? {
          parts: [
            { label: t("way.all") },
            ...model.way.map((part) =>
              part.open ? { label: part.label, onPress: part.open } : { label: part.label },
            ),
          ],
          title: [t("way.all"), ...model.path].join(" / "),
          more: { label: "…" },
        }
      : undefined;
  return (
    <ListHead
      title={model.goneName ?? leaf}
      hot={model.fresh.some((m) => m.unread)}
      way={way}
      count={
        model.count !== undefined && model.count > 0 ? t("metaCount", { count: model.count }) : undefined
      }
      aside={<ListMenu label={t("list.menu")} items={[]} />}
    />
  );
}

/** Move, at the row's menu: the folders of the letter's own mailbox it may go to; one press sends one move. */
function FolderMoveAsk({
  move,
  source,
  letters,
  at,
  close,
  onMoved,
}: {
  move: FolderMove;
  source: string;
  letters: readonly EngineMessage[];
  at: HTMLElement;
  close: () => void;
  onMoved?: () => void;
}) {
  const t = useText("folder");
  const { host } = useFrame();
  const choices = letters.map((letter) => new Map(move.into(letter).map((to) => [to.folder.id, to])));
  const offered = [...(choices[0]?.values() ?? [])].flatMap((to) => {
    if (choices.some((row) => !row.has(to.folder.id))) return [];
    return [{ ...to, disabled: choices.some((row) => row.get(to.folder.id)?.disabled === true) }];
  });
  return (
    <MovePicker
      open
      onClose={close}
      anchor={at}
      label={t("move.title")}
      title={t("move.title")}
      places={[]}
      folders={offered.map(({ folder, disabled }) => ({
        id: folder.id,
        name: folderLeafOf(folder.name),
        path: folder.name,
        disabled,
      }))}
      onMove={(id) => {
        const to = offered.find(({ folder }) => folder.id === id);
        close();
        const route = routeOf(host.device.address.read());
        if (route.place !== "folder" || route.sub !== source || to === undefined || to.disabled) return;
        for (const letter of letters) move.send(source, letter, to.folder);
        onMoved?.();
      }}
    />
  );
}
