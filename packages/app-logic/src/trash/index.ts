/** The door of `trash`: what ohmail deleted, with Restore, and the mail server's own Trash, read-only. */
export {
  useLiveTrashEnabled,
  useTrashLive,
  type TrashLiveArgs,
  type TrashLiveOwn,
  type TrashSeam,
} from "./live.js";
export { TrashModelContext, useTrashList, useTrashModel, type TrashInput, type TrashModel } from "./model.js";
export {
  trashLiveKeyOf,
  trashLiveState,
  useTrashWindow,
  type TrashLiveState,
  type TrashLiveWire,
  type TrashWindowControl,
  type TrashWindowItemWire,
  type TrashWindowMailboxWire,
  type TrashWindowPageWire,
} from "./live-window.js";
