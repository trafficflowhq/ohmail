/**
 * The door of `mail`: the mail product's composition entry. A shell imports it, hands `MailGround` as what it stands
 * above every pane and takes its places from `mailPlaces()` and its stages from `mailStages()`; a browser's shell
 * takes all three, with Settings over its registered sections (`mailSettings()`) and the address and the facts of its
 * window, as one record from `useMailSupplies()`, over the look of the theme it stands under (`useThemeLook()`) and
 * the one record of its own parts (`MailHostParts`: its reader, made once with `mailReader()`, and what it alone can
 * hand a stage or a section). No place's folder and no file of the frame imports it.
 */
export { MailGround } from "./MailGround.js";
export {
  OhboxStartupContext,
  SavedOhboxList,
  type OhboxStartup,
  type SavedOhbox,
} from "../ohbox/SavedOhbox.js";
export { MailConnectionDetails } from "./ground/MailConnection.js";
export { MailStateMount } from "./ground/MailStateMount.js";
export { mailPanes, mailSettings, NO_PANE_PARTS, type MailPaneParts } from "./panes.js";
export { mailPlaces, type MailPlaces } from "./places.js";
export { mailReader, useMailReaderParts, type MailReaderHost } from "./reader-parts.js";
export { mailStages, NO_STAGE_PARTS, type MailStageParts } from "./stages.js";
export { useThemeLook } from "./look.js";
export { useMailSupplies, type MailHostParts } from "./supplies.js";
export {
  newFaceEdits,
  useAccountLook,
  type ApplyFaceAllDevices,
  type FaceEdits,
} from "../settings/general/boot-face.js";
export { MailRichEditor, prepareWriting } from "../write/rich-entry.js";
