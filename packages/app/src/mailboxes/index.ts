/**
 * THE MAILBOXES PANE: its registration for Settings, its notices for the notice slot, the pane itself over plain
 * inputs, and its states for the comparison. Its one line is in the mail's panes record (`mail/panes.ts`), over what a
 * host alone hands it (`MailboxesParts`) and the ground's own mail state; no shell registers it.
 */
export { MailboxesPane, type MailboxesPaneProps } from "./pane/MailboxesPane.js";
export { mailboxesPane, type MailboxesParts, type MailboxesSlots, type PaneMailState } from "./pane/pane.js";
export { mailboxesNotices } from "./pane/notices.js";
export { PANE_NAMESPACES } from "./pane/say.js";
export { mailboxesStates, type MailboxesPaneState } from "./pane/states.js";
