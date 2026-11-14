/**
 * TAGS' LIST. One tag: its letters across every place, read in place, with Rename and Delete in the list's menu.
 * Every tag (no tag named): each tag a group that shuts and opens, its letters under it.
 */
import { useRef, useState } from "react";
import { useTagsModel, type TagsModel } from "@ohmail/app-logic/tags";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useText, type Text } from "../text/index.js";
import { TagDelete, TagRename } from "./TagAsks.js";

export function TagsList({ plan }: PaneProps) {
  const model = useTagsModel();
  const t = useText("tags");
  const [asked, setAsked] = useState<"rename" | "delete" | null>(null);
  const menuAt = useRef<HTMLButtonElement>(null);
  const tag = model.tag;
  const head = (
    <ListHead
      title={tag?.name ?? t("title")}
      hot={tag !== null && model.list.rows.some((m) => m.unread)}
      count={
        tag !== null && model.list.rows.length > 0
          ? t("count.letters", { count: model.list.rows.length })
          : undefined
      }
      aside={
        <ListMenu
          label={t("list.menu")}
          anchorRef={menuAt}
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
              : []
          }
        />
      }
    />
  );
  return (
    <ListColumn head={head} plan={plan}>
      {tag !== null ? <OneTag model={model} t={t} /> : <EveryTag model={model} t={t} />}
      {model.loading ? <Empty label={t("loading")} /> : null}
      {model.empty ? <Empty label={tag === null ? t("empty.none") : t("empty.tag")} /> : null}
      {model.gone ? <Empty label={t("gone")} /> : null}
      {tag !== null && asked === "rename" ? (
        <TagRename tag={tag} model={model} anchor={menuAt} close={() => setAsked(null)} />
      ) : null}
      {tag !== null && asked === "delete" ? (
        <TagDelete tag={tag} model={model} close={() => setAsked(null)} />
      ) : null}
    </ListColumn>
  );
}

function OneTag({ model, t }: { model: TagsModel; t: Text }) {
  if (model.list.rows.length === 0) return null;
  return (
    <LetterRows
      label={model.tag?.name ?? t("title")}
      rows={model.list.rows}
      openId={model.list.openId}
      press={model.list.press}
      stamp={model.stamp}
      file={t("row.file")}
      who={(m) => m.from.name ?? m.from.address}
      spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
    />
  );
}

function EveryTag({ model, t }: { model: TagsModel; t: Text }) {
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
              label={g.tag.name}
              rows={g.rows}
              openId={model.list.openId}
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
