/**
 * The door of `mail`: the mail product's composition entry. A shell imports it, hands `MailGround` as what it stands
 * above every pane and takes its places from `mailPlaces()`. No place's folder and no file of the frame imports it.
 */
export { MailGround } from "./MailGround.js";
export { mailPlaces, type MailPlaces } from "./places.js";
