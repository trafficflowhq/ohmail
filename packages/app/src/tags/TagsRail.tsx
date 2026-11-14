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
import { useTagsRailLive } from "@ohmail/app-logic/tags";
import { UI_KEYS, usePersistedFlag } from "@ohmail/app-logic/storage/persisted-ui";
import { hueOf } from "@ohmail/app-logic/text/format";
import { design } from "@ohmail/ui/base";
import { RailEntry, RailField } from "@ohmail/ui/mail";
import type { TagDTO } from "@ohmail/wire";
import { usePress } from "../frame/room.js";
import { newTagName } from "../settings/tags/model.js";
import { useFrame } from "../frame/commands.js";
import { useRailDropState } from "../frame/rail-drag.js";
import { useText } from "../text/index.js";
import "./tags.css";

/** A tag's stored hue name as the degrees the kit's dot takes: the design's own, moss for a name it does not hold. */
const TAG_HUES = design.tagHues as Readonly<Record<string, number>>;
const TAG_HUE_NAMES = Object.keys(TAG_HUES);

export function TagsRail() {
  const t = useText("tags");
  const { route, commands } = useFrame();
  const { tags } = useTagsRailLive();
  const [open, setOpen] = usePersistedFlag(UI_KEYS.tagsOpen, false);
  const rail = useText("rail");
  const at = route.place === "tags" ? route.sub : null;
  return (
    <>
      <RailEntry
        kind="fold"
        expanded={open}
        none={tags.length === 0 ? rail("tagEmpty") : undefined}
        current={!open && route.place === "tags"}
        onPress={() => setOpen(!open)}
      >
        {t("title")}
      </RailEntry>
      {open
        ? tags.map(({ tag, count }) => (
            <TagEntry
              key={tag.id}
              tag={tag}
              count={count}
              current={at === tag.id}
              go={() => commands.go({ place: "tags", sub: tag.id })}
            />
          ))
        : null}
      {open ? <NewTag tags={tags.map(({ tag }) => tag)} /> : null}
    </>
  );
}

function NewTag({ tags }: { readonly tags: readonly TagDTO[] }) {
  const [editing, setEditing] = useState(false);
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
      hue={TAG_HUES.moss ?? 150}
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
  count,
  current,
  go,
}: {
  readonly tag: TagDTO;
  readonly count: number;
  readonly current: boolean;
  readonly go: () => void;
}) {
  const drop = useRailDropState({ kind: "tag", tagId: tag.id });
  return (
    <span className="tg-railtarget" data-rail-tag-id={tag.id}>
      <RailEntry
        kind="sub"
        drop={drop}
        hue={TAG_HUES[hueOf(tag, TAG_HUE_NAMES)] ?? 150}
        count={count > 0 ? String(count) : undefined}
        current={current}
        title={tag.name}
        onPress={go}
      >
        {tag.name}
      </RailEntry>
    </span>
  );
}
