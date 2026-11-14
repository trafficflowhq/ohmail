/** The door of `folder`: one of the mailbox's own folders, read in place beside the reader. */
export {
  FolderModelContext,
  useFolderList,
  useFolderModel,
  type FolderInput,
  type FolderModel,
} from "./model.js";
export {
  folderMoveRefusal,
  foldersToMoveInto,
  folderWaitingRefusal,
  moveIntoFolder,
  type FolderMoveWords,
  type FolderToMoveInto,
  type MoveMailbox,
  type MovePressSeam,
} from "./move.js";
export {
  FIND_FROM,
  foldOf,
  RECENT_SIZE,
  SHELF_SIZE,
  shelfKeyOf,
  shelfOf,
  treeOrder,
  usedNow,
  type FoldGroup,
  type FoldRow,
  type ShelfFacts,
} from "./shelf.js";
