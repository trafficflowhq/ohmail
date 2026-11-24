/** The door of `tags`: one tag across every place, or every tag, beside the reader. */
export {
  TagsModelContext,
  judgeTagName,
  useTagsList,
  useTagsModel,
  type RenameAnswer,
  type TagGroup,
  type TagsInput,
  type TagsModel,
} from "./model.js";
export { useTagsLive, useTagsRailLive, type TagsLiveOwn } from "./live.js";
export { deleteTag, renameTag } from "../press/tag-verbs.js";
