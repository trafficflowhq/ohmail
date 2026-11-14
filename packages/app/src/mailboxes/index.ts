/**
 * THE MAILBOXES PANE: its registration for Settings, the pane itself over plain inputs, and its states for the
 * comparison. Held, unseated: no shell registers it until its seat.
 */
export { MailboxesPane, type MailboxesPaneProps } from "./pane/MailboxesPane.js";
export { mailboxesPane, type MailboxesSlots, type PaneMailState } from "./pane/pane.js";
export { PANE_NAMESPACES } from "./pane/say.js";
export { mailboxesStates, type MailboxesPaneState } from "./pane/states.js";
