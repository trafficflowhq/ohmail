"use client";

import { usePlaceLiveArgs } from "../../frame/index.js";
import { TAG_COLOURS, TagsPane, tagHue, type TagsModel } from "../tags/index.js";
import { useText } from "../../text/index.js";
import { wordsOver } from "@ohmail/app-logic/reader";
import { deleteTag, renameTag, useTagsRailLive } from "@ohmail/app-logic/tags";

export function BrowserTagsPane() {
  const { press } = usePlaceLiveArgs();
  const { tags } = useTagsRailLive();
  const tagWords = useText("tag");
  const cx = { press, t: wordsOver({ tag: tagWords }), tags: tags.map(({ tag }) => tag) };
  const model: TagsModel = {
    tags: tags.map(({ tag, count }) => ({
      id: tag.id,
      name: tag.name,
      colour: tag.hue,
      hue: tagHue(tag.hue),
      count,
    })),
    colours: TAG_COLOURS,
    newHue: tagHue("moss"),
    notOnServer: tagWords("notOnServer"),
    verbs: {
      create(name) {
        void press.mutateAndReport(
          { kind: "tag_create", tagId: crypto.randomUUID(), name },
          tagWords("toastCreated", { name }),
        );
      },
      rename: (id, name) => renameTag(cx, id, name),
      recolour(id, hue) {
        void press.mutateAndReport({ kind: "tag_recolor", tagId: id, hue }, null);
      },
      remove: (id) => deleteTag(cx, id),
    },
  };
  return <TagsPane model={model} />;
}
