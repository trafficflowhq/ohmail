/**
 * TAGS' LIST. One tag: its letters across every place, read in place, with Rename and Delete in the list's menu.
 * Every tag (no tag named): each tag a group that shuts and opens, its letters under it.
 */
import { useEffect, useRef, useState } from "react";
import { useListWindow } from "@ohmail/app-logic/lists";
import { useTagsModel, type TagsModel } from "@ohmail/app-logic/tags";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { LetterRows, ListColumn, ListMenu, usePlaceLabel } from "../place-list/index.js";
import { useText, type Text } from "../text/index.js";
import { TagDelete, TagRename } from "./TagAsks.js";

import { MailSelectionFoot } from "../place-list/MailSelectionFoot.js";
import { useRowContact, type RowContact } from "../place-list/use-row-contact.js";
import { useRowSelection, type RowSelection } from "../place-list/use-row-selection.js";

export function TagsList({ plan }: PaneProps) {
  const model = useTagsModel();
  return <TagsColumn key={model.tag?.id ?? ""} plan={plan} model={model} />;
}

function TagsColumn({ plan, model }: { plan: PaneProps["plan"]; model: TagsModel }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { rows, cursor } = model.list;
  const selection = useRowSelection(rows);
  const contact = useRowContact();
  const win = useListWindow({
    scrollerRef: scroller,
    count: model.tag === null ? 0 : rows.length,
    cursor:
      model.tag === null || cursor === null
        ? undefined
        : { id: cursor, index: rows.findIndex((row) => row.id === cursor) },
  });
  const { commands } = useFrame();
  const t = useText("tags");
  const newTag = useText("rail")("tagNew");
  const [asked, setAsked] = useState<"rename" | "delete" | null>(null);
  const menuAt = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (model.gone) commands.go({ place: "ohbox", open: null }, { replace: true });
  }, [commands, model.gone]);
  if (model.gone) return null;
  const tag = model.tag;
  const head = (
    <ListHead
      title={tag?.name ?? t("title")}
      hot={tag !== null && model.list.rows.some((m) => m.unread)}
      count={
        tag !== null && model.count !== undefined && model.count > 0
          ? t("count.letters", { count: model.count })
          : undefined
      }
      below={
        tag !== null && asked === "rename" ? (
          <TagRename
            tag={tag}
            model={model}
            close={() => {
              setAsked(null);
              menuAt.current?.focus({ preventScroll: true });
            }}
          />
        ) : undefined
      }
      aside={
        <ListMenu
          label={t("list.menu")}
          anchorRef={menuAt}
          mail={tag === null}
          items={
            tag !== null
              ? [
                  {
                    label: t("menu.rename"),
                    icon: "write",
                    apart: true,
                    onPress: () => setAsked("rename"),
                  },
                  { label: t("menu.delete"), icon: "trash", onPress: () => setAsked("delete") },
                ]
              : [
                  {
                    label: newTag,
                    icon: "plus",
                    apart: true,
                    onPress: () => commands.go({ place: "settings", sub: "tags" }),
                  },
                ]
          }
        />
      }
    />
  );
  return (
    <ListColumn
      head={head}
      foot={<MailSelectionFoot selection={selection} verbs={model.list.verbs} />}
      plan={plan}
      cursor={model.list.cursor}
      scrollerRef={scroller}
      manualScrollAnchor={tag !== null && win.end - win.start < rows.length}
    >
      {tag !== null ? (
        <OneTag model={model} t={t} win={win} selection={selection} contact={contact} />
      ) : (
        <EveryTag model={model} t={t} selection={selection} contact={contact} />
      )}
      {model.loading ? <Empty label={t("loading")} /> : null}
      {model.empty ? <Empty label={tag === null ? t("empty.none") : t("empty.tag")} /> : null}
      {tag !== null && asked === "delete" ? (
        <TagDelete tag={tag} model={model} close={() => setAsked(null)} />
      ) : null}
      {contact.card}
    </ListColumn>
  );
}

type TagRowsProps = { model: TagsModel; t: Text; selection: RowSelection; contact: RowContact };
function OneTag({
  model,
  t,
  win,
  selection,
  contact,
}: TagRowsProps & { win: ReturnType<typeof useListWindow> }) {
  const place = usePlaceLabel();
  if (model.list.rows.length === 0) return null;
  return (
    <LetterRows
      selection={selection}
      contact={contact}
      label={model.tag?.name ?? t("title")}
      rows={model.list.rows}
      where={(message) => place(message.physicalFolder ?? message.folder)}
      windowed={{
        start: win.start,
        total: model.list.rows.length,
        top: win.padTop,
        bottom: win.padBottom,
        rowHeight: win.rowHeight,
        slots: model.list.rows.slice(win.start, win.end),
      }}
      cursor={model.list.cursor}
      press={model.list.press}
      stamp={model.stamp}
      file={t("row.file")}
      who={(m) => m.from.name ?? m.from.address}
      spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
    />
  );
}

function EveryTag({ model, t, selection, contact }: TagRowsProps) {
  const place = usePlaceLabel();
  return (
    <>
      {model.groups.map((g) => (
        <section key={g.tag.id} aria-label={g.tag.name}>
          <GroupHeading
            count={String(g.rows.length)}
            expanded={!g.shut}
            onPress={() => model.toggle(g.tag.id)}
          >
            {g.tag.name}
          </GroupHeading>
          {!g.shut && g.rows.length > 0 ? (
            <LetterRows
              selection={selection}
              contact={contact}
              label={g.tag.name}
              rows={g.rows}
              where={(message) => place(message.physicalFolder ?? message.folder)}
              cursor={model.list.cursor}
              press={model.list.press}
              stamp={model.stamp}
              file={t("row.file")}
              who={(m) => m.from.name ?? m.from.address}
              spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
            />
          ) : null}
        </section>
      ))}
    </>
  );
}
