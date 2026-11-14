/**
 * A FOLDER'S LIST: its name with the way to it (Folders, then each folder above it), how many letters it holds and the
 * list's menu; what is new and what came before. A row's own menu moves its letter into another of the mailbox's
 * folders, where the seat hands the Move.
 * Empty, it says the folder holds nothing; gone from the mail server, it says so by name.
 */
import { useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { useFolderModel, type FolderMove } from "@ohmail/app-logic/folder";
import { folderLeafOf } from "@ohmail/app-logic/lists/folders";
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { GroupHeading, ListHead, ListLine, MovePicker, type Way } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { routeOf } from "../frame/route.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useCursorWindow } from "../place-list/cursor-window.js";
import { useText } from "../text/index.js";

export function FolderList({ plan }: PaneProps) {
  const model = useFolderModel();
  const t = useText("folder");
  const olderWords = useText("ohbox");
  const [asked, setAsked] = useState<{ folderId: string; id: string; at: { x: number; y: number } } | null>(
    null,
  );
  const { move, older } = model;
  const folderId = model.folder?.id;
  const letter =
    asked && asked.folderId === folderId ? model.list.rows.find((m) => m.id === asked.id) : undefined;
  if (asked && (letter === undefined || move === null)) setAsked(null);
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
  const head = (
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
  const both = model.fresh.length > 0 && model.earlier.length > 0;
  const cursor = model.list.cursor;
  const selected = model.list.rows.findIndex((m) => m.id === cursor);
  const cursorIndex = selected < 0 || !both ? selected : selected + (selected < model.fresh.length ? 1 : 2);
  const { scroller, window } = useCursorWindow(model.list.rows.length + (both ? 2 : 0), cursorIndex, cursor);
  const rows = (label: string, list: typeof model.fresh, index: number) => {
    const first = Math.max(0, window.start - index);
    const slice = list.slice(first, Math.max(0, window.end - index));
    const showHeading = both && window.start <= index - 1 && index - 1 < window.end;
    if (slice.length === 0 && !showHeading) return null;
    return (
      <section aria-label={label}>
        {showHeading ? (
          <div data-index={index - 1}>
            <GroupHeading count={String(list.length)}>{label}</GroupHeading>
          </div>
        ) : null}
        <LetterRows
          label={label}
          rows={slice}
          slice={{ index: index + first, first, total: list.length }}
          cursor={model.list.cursor}
          press={model.list.press}
          stamp={model.stamp}
          file={t("row.file")}
          who={(m) => m.from.name ?? m.from.address}
          spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
          onMenu={
            move === null || folderId === undefined
              ? undefined
              : (m, at) => setAsked({ folderId, id: m.id, at })
          }
        />
      </section>
    );
  };
  return (
    <ListColumn head={head} plan={plan} cursor={cursor} scrollerRef={scroller}>
      <div aria-hidden data-window-top="" style={{ height: window.padTop }} />
      {rows(t("group.new"), model.fresh, both ? 1 : 0)}
      {rows(t("group.earlier"), model.earlier, model.fresh.length + (both ? 2 : 0))}
      {window.padBottom > 0 ? <div aria-hidden style={{ height: window.padBottom }} /> : null}
      {model.goneName !== null ? <Empty label={t("gone", { name: model.goneName })} /> : null}
      {model.empty ? <Empty label={t("emptyTitle")} /> : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
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
      {move !== null && asked !== null && letter !== undefined ? (
        <FolderMoveAsk
          move={move}
          source={asked.folderId}
          m={letter}
          at={asked.at}
          close={() => setAsked(null)}
        />
      ) : null}
    </ListColumn>
  );
}

/** Move, at the row's menu: the folders of the letter's own mailbox it may go to; one press sends one move. */
function FolderMoveAsk({
  move,
  source,
  m,
  at,
  close,
}: {
  move: FolderMove;
  source: string;
  m: EngineMessage;
  at: { x: number; y: number };
  close: () => void;
}) {
  const t = useText("folder");
  const { host } = useFrame();
  const offered = move.into(m);
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
        if (route.place === "folder" && route.sub === source && to !== undefined && !to.disabled)
          move.send(source, m, to.folder);
      }}
    />
  );
}
