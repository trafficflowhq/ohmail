/**
 * THE RAIL'S TAGS GROUP, drawn by the Tags place for the frame's life: the line Tags, which shuts and opens what is
 * under it (kept on this device, shut until a person opens it), and under it every tag by name with its dot and how
 * many letters carry it. A tag opens its place. Shut, the line wears the current look while a tag's place is open.
 * It reads the ground alone (`useTagsRailLive`), never Tags' own model, which stands only with its columns.
 *
 * A LETTER DRAGGED FROM A LIST ONTO A TAG is tagged by the list's own verb (the frame's gesture, `useRailDrag`): each
 * tag's entry stands in a box that names its tag (`data-rail-tag-id`), where the gesture finds its target, and lights
 * where the drop would change something. The group files nothing itself.
 */
import { useState } from "react";
import { deleteTag, judgeTagName, renameTag, useTagsRailLive } from "@ohmail/app-logic/tags";
import { UI_KEYS, usePersistedFlag } from "@ohmail/app-logic/storage/persisted-ui";
import { RailEntry, RailField } from "@ohmail/ui/mail";
import type { TagDTO } from "@ohmail/wire";
import { usePress } from "../frame/room.js";
import { newTagName } from "../settings/tags/model.js";
import { useFrame } from "../frame/commands.js";
import { useRailDropState } from "../frame/rail-drag.js";
import { useText } from "../text/index.js";
import { Menu } from "@ohmail/ui/base";
import { wordsOver } from "@ohmail/app-logic/reader";
import { MailRowMenu, type MenuTarget } from "../place-list/MailRowMenu.js";
import { TagDelete, TagRename } from "./TagAsks.js";
import { tagHue } from "./colours.js";
import "./tags.css";

export function TagsRail() {
  const t = useText("tags");
  const { route, commands } = useFrame();
  const { tags } = useTagsRailLive();
  const allTags = tags.map(({ tag }) => tag);
  const [open, setOpen] = usePersistedFlag(UI_KEYS.tagsOpen, false);
  const rail = useText("rail");
  const row = useText("ohbox");
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editing, setEditing] = useState(false);
  const at = route.place === "tags" ? route.sub : null;
  return (
    <>
      <RailEntry
        kind="fold"
        expanded={open}
        none={tags.length === 0 ? rail("tagEmpty") : undefined}
        current={!open && route.place === "tags"}
        currentMark={route.place === "tags" && at === null}
        onPress={() => {
          setOpen(!open);
          setEditing(false);
        }}
        onMenu={(at, anchor) => setMenu({ at, anchor })}
      >
        {t("title")}
      </RailEntry>
      {menu ? (
        <MailRowMenu
          target={menu}
          label={t("title")}
          onClose={() => setMenu(null)}
          items={[
            {
              label: row("row.open"),
              icon: "tags",
              onPress: () => {
                setOpen(!open);
                setEditing(false);
              },
            },
            {
              label: rail("tagNew"),
              icon: "plus",
              onPress: () => {
                setOpen(true);
                setEditing(true);
              },
            },
          ]}
        />
      ) : null}
      {open
        ? tags.map(({ tag, count }) => (
            <TagEntry
              key={tag.id}
              tag={tag}
              tags={allTags}
              count={count}
              current={at === tag.id}
              go={() => commands.go({ place: "tags", sub: tag.id })}
            />
          ))
        : null}
      {open ? <NewTag tags={allTags} editing={editing} setEditing={setEditing} /> : null}
    </>
  );
}

function NewTag({
  tags,
  editing,
  setEditing,
}: {
  readonly tags: readonly TagDTO[];
  readonly editing: boolean;
  readonly setEditing: (editing: boolean) => void;
}) {
  const label = useText("rail")("tagNew");
  const t = useText("tag");
  const press = usePress();
  if (!editing)
    return (
      <RailEntry kind="sub" icon="plus" quiet onPress={() => setEditing(true)}>
        {label}
      </RailEntry>
    );
  return (
    <RailField
      label={label}
      placeholder={t("newPlaceholder")}
      hue={tagHue("moss")}
      maxLength={40}
      problem={(name) => (newTagName(tags, name)?.taken ? t("newTaken", { name }) : undefined)}
      onCancel={() => setEditing(false)}
      onCommit={(name) => {
        setEditing(false);
        void press.mutateAndReport(
          { kind: "tag_create", tagId: crypto.randomUUID(), name },
          t("toastCreated", { name }),
        );
      }}
    />
  );
}

/** One tag's entry, in the box a dragged letter finds it by. */
function TagEntry({
  tag,
  tags,
  count,
  current,
  go,
}: {
  readonly tag: TagDTO;
  readonly tags: readonly TagDTO[];
  readonly count: number;
  readonly current: boolean;
  readonly go: () => void;
}) {
  const rail = useText("rail");
  const t = useText("tags");
  const ohbox = useText("ohbox");
  const screening = useText("screening");
  const session = useText("session");
  const tagText = useText("tag");
  const press = usePress();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [ask, setAsk] = useState<{ kind: "rename" | "delete"; target: MenuTarget } | null>(null);
  const cx = { press, tags, t: wordsOver({ ohbox, screening, session, tag: tagText }) };
  const drop = useRailDropState({ kind: "tag", tagId: tag.id });
  return (
    <span className="tg-railtarget" data-rail-tag-id={tag.id}>
      <RailEntry
        kind="sub"
        drop={drop}
        hue={tagHue(tag.hue)}
        count={count > 0 ? String(count) : undefined}
        current={current}
        title={count > 0 ? rail("tagTitle", { count }) : tag.name}
        onPress={go}
        onMenu={(at, anchor) => setMenu({ at, anchor })}
      >
        {tag.name}
      </RailEntry>
      {menu ? (
        <MailRowMenu
          target={menu}
          label={tag.name}
          onClose={() => setMenu(null)}
          items={[
            { label: ohbox("row.open"), icon: "tags", onPress: go },
            {
              label: t("menu.rename"),
              icon: "write",
              onPress: () => setAsk({ kind: "rename", target: menu }),
            },
            {
              label: t("menu.delete"),
              icon: "trash",
              onPress: () => setAsk({ kind: "delete", target: menu }),
            },
          ]}
        />
      ) : null}
      {ask?.kind === "rename" ? (
        <Menu
          open
          kind="ask"
          label={t("menu.rename")}
          anchor={ask.target.at}
          returnFocus={ask.target.anchor}
          onClose={() => setAsk(null)}
        >
          <TagRename
            tag={tag}
            close={() => setAsk(null)}
            model={{
              judge: (id, draft) => judgeTagName(tags, id, draft),
              rename: (id, name) => renameTag(cx, id, name),
            }}
          />
        </Menu>
      ) : null}
      {ask?.kind === "delete" ? (
        <TagDelete
          tag={tag}
          returnFocus={() => ask.target.anchor}
          close={() => setAsk(null)}
          model={{
            countOf: () => count,
            remove: (id) => deleteTag(cx, id),
          }}
        />
      ) : null}
    </span>
  );
}
