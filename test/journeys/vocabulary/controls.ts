import type { CatalogueKey } from "./catalogue.js";
import { PLACES, type AriaRole, type PlaceId } from "./places.js";

/**
 * The controls a journey names. Each is found by its ROLE and its NAME, and the name is the
 * catalogue's text for `key` in the run's language, matched whole.
 *
 * `nameFrom` says where the name comes from when it is not the key alone:
 *  - "key" (the default): the catalogue's text, arguments filled;
 *  - "visible": a name the world gives (a conversation's sender and subject, a tag's own name);
 *  - "none": a landmark that has no name (the page's one `main`).
 */
export interface Control {
  id: string;
  role: AriaRole;
  key: CatalogueKey | null;
  /** The control this one is inside; a place means "inside that place's content". */
  within?: PlaceId | string;
  nameFrom?: "key" | "visible" | "none";
  /** The app may follow the name with a count ("Ohbox 3"). */
  counted?: true;
  /** The app nests a second control of the same role and name inside this one; the outer one is meant. */
  outer?: true;
  /** The app draws this control twice in one place, for the same act; either one is it. */
  either?: true;
}

const c = (id: string, role: AriaRole, key: CatalogueKey | null, more: Partial<Control> = {}): [string, Control] =>
  [id, { id, role, key, ...more }];

const entries: Array<[string, Control]> = [
  // The frame.
  c("content", "main", null, { nameFrom: "none" }),
  c("rail", "navigation", "rail.ariaMain"),
  c("rail-compose", "button", "rail.compose", { within: "rail" }),
  c("rail-ohbox", "button", "rail.ohbox", { within: "rail", counted: true }),
  c("rail-reads", "button", "rail.reads", { within: "rail", counted: true }),
  c("rail-receipts", "button", "rail.receipts", { within: "rail", counted: true }),
  c("rail-screener", "button", "rail.screener", { within: "rail", counted: true }),
  c("rail-reply-later", "button", "rail.replyLater", { within: "rail", counted: true }),
  c("rail-set-aside", "button", "rail.setAside", { within: "rail", counted: true }),
  c("rail-resurface", "button", "rail.resurface", { within: "rail", counted: true }),
  c("rail-history", "button", "rail.history", { within: "rail" }),
  c("rail-search", "button", "rail.search", { within: "rail" }),
  c("rail-drafts", "button", "rail.drafts", { within: "rail", counted: true }),
  c("rail-trash", "button", "rail.trash", { within: "rail", counted: true }),
  c("rail-settings", "button", "rail.settings", { within: "rail" }),
  c("demo-dismiss", "button", "ribbon.dismiss"),

  // Lists and their rows.
  c("list-new", "listbox", "ohbox.newForYou", { within: "content" }),
  c("list-earlier", "listbox", "ohbox.previouslySeen", { within: "content" }),
  c("list-reads", "listbox", "reads.title", { within: "content" }),
  c("list-receipts", "listbox", "receipts.title", { within: "content" }),
  c("list-screener", "listbox", "screener.title", { within: "content" }),
  c("list-triage", "listbox", "triage.title", { within: "content" }),
  c("list-history", "listbox", "history.title", { within: "content" }),
  c("list-drafts", "listbox", "drafts.title", { within: "content" }),
  c("list-trash", "listbox", "rail.trash", { within: "content" }),
  c("conversation", "option", null, { within: "content", nameFrom: "visible" }),
  c("mark-all-read", "button", "markAll.aria", { within: "content" }),

  // The open message.
  c("reader", "region", "reader.pane"),
  c("letter", "article", null, { within: "reader", nameFrom: "none" }),
  c("reply", "button", "ohbox.actionReply", { within: "reader" }),
  c("forward", "button", "message.menuForward", { within: "reader" }),
  c("mark-unread", "button", "ohbox.actionMarkUnread", { within: "reader" }),
  c("more", "button", "ohbox.actionMore", { within: "reader" }),
  c("park", "button", "ohbox.actionSetAside", { within: "reader" }),
  c("later", "button", "ohbox.actionLater", { within: "reader" }),
  c("images-blocked", "button", "mailBody.imagesCaption", { within: "content" }),
  c("show-original", "button", "mailBody.design", { within: "content" }),
  c("show-as-text", "button", "mailBody.plain", { within: "content" }),
  c("reply-send", "button", "reply.send", { within: "reader" }),

  // Compose.
  c("compose-to", "combobox", "compose.to", { within: "content" }),
  c("compose-subject", "textbox", "compose.subject", { within: "content" }),
  c("compose-body", "textbox", "compose.editorAria", { within: "content" }),
  c("compose-send", "button", "compose.send", { within: "content" }),
  c("compose-cancel", "button", "compose.cancel", { within: "content" }),
  c("compose-bold", "button", "compose.rte.bold", { within: "content" }),

  // Search.
  c("search-box", "textbox", "search.aria", { within: "content" }),
  c("search-hit", "button", null, { within: "content", nameFrom: "visible" }),

  // The Screener.
  c("screener-sections", "tablist", "screener.segAria", { within: "content" }),
  c("screener-waiting", "tab", "screener.segWaiting", { within: "screener-sections", counted: true }),
  c("screener-screened", "tab", "screener.segScreened", { within: "screener-sections", counted: true }),
  c("screener-spam", "tab", "screener.segSpam", { within: "screener-sections", counted: true }),
  c("screener-destinations", "menu", "screener.rowMoreAria", { within: "content" }),

  // Triage.
  c("triage-piles", "group", "triage.pilesAria", { within: "content" }),
  c("triage-reply-later", "button", "triage.replyLater", { within: "triage-piles", counted: true }),
  c("triage-set-aside", "button", "triage.setAside", { within: "triage-piles", counted: true }),
  c("triage-resurface", "button", "triage.resurface", { within: "triage-piles", counted: true }),

  // Settings.
  c("settings-menu", "navigation", "settings.navAria", { within: "content" }),
  c("settings-pane", "region", "settings.title", { within: "content" }),
  c("language", "group", "settings.languageAria", { within: "settings-pane", outer: true }),
  c("theme", "group", "settings.themeAria", { within: "settings-pane", outer: true }),
  c("theme-dark", "button", "settings.themeDark", { within: "theme" }),
  c("theme-light", "button", "settings.themeLight", { within: "theme" }),
  c("theme-auto", "button", "settings.themeAuto", { within: "theme" }),
  c("language-en", "button", "settings.languageName.en", { within: "language" }),
  c("language-de", "button", "settings.languageName.de", { within: "language" }),
  c("notify-master", "switch", "settings.notifyMaster", { within: "settings-pane" }),
  c("mailbox-connect", "button", "mailboxes.connect", { within: "settings-pane" }),
  c("mailbox-sync", "button", "mailboxes.syncNow", { within: "settings-pane" }),
  c("posture", "switch", "settings.screening.postureTitle", { within: "settings-pane" }),
  c("ai-switch", "switch", "settings.aiLabel", { within: "settings-pane" }),
  c("away-switch", "switch", "away.title", { within: "settings-pane" }),
  c("away-message", "textbox", "away.bodyLabel", { within: "settings-pane" }),
  c("away-save", "button", "away.save", { within: "settings-pane", either: true }),
  c("invite-for", "textbox", "invites.mintFor", { within: "settings-pane" }),
  c("invite-make", "button", "invites.mintAction", { within: "settings-pane" }),
  c("rule-revoke", "button", "rules.revoke", { within: "settings-pane" }),
  c("tag-new", "textbox", "settings.tagNew", { within: "settings-pane" }),
  c("tag-add", "button", "settings.tagAdd", { within: "settings-pane" }),
  c("rail-tag", "button", null, { within: "rail", nameFrom: "visible", counted: true }),
  c("folders-switch", "switch", "settings.folders.useTitle", { within: "settings-pane" }),
  c("signature-editor", "textbox", null, { within: "settings-pane", nameFrom: "visible" }),
  c("signature-save", "button", "settings.signatures.save", { within: "settings-pane" }),
  c("leave-keep", "button", "settings.signatures.leaveKeep"),
  c("about-build", "group", "about.buildLabel", { within: "settings-pane" }),
  c("recovery-codes", "button", "security.codesGenerate", { within: "settings-pane" }),
  c("change-password", "button", "passwordChange.submit", { within: "settings-pane" }),
  c("device-for", "textbox", "devices.addFor", { within: "settings-pane" }),
  c("device-add", "button", "devices.addAction", { within: "settings-pane" }),
  c("sign-out", "button", "account.signOut", { within: "settings-pane" }),
  c("erase-begin", "button", "account.begin", { within: "settings-pane" }),
  c("erase-confirm", "textbox", "account.typeLabel", { within: "settings-pane" }),

  // The doors.
  c("login-email", "textbox", "login.emailLabel"),
  c("login-password", "textbox", "login.passwordLabel"),
  c("login-continue", "button", "login.continue"),
];

/** A Settings pane's entry in the Settings menu: the pane place's own landmark. */
for (const [id, place] of Object.entries(PLACES)) {
  if (id.startsWith("settings-")) entries.push(c(`menu-${id}`, place.landmark.role, place.landmark.key, { within: "settings-menu" }));
}

export const CONTROLS: Readonly<Record<string, Control>> = Object.freeze(Object.fromEntries(entries));
export type ControlId = string;

export function control(id: ControlId): Control {
  const found = CONTROLS[id];
  if (!found) throw new Error(`the vocabulary has no control ${JSON.stringify(id)}`);
  return found;
}

/** A conversation's row is named by who it is from and what it is about. */
export const conversationName = (from: string, subject: string): string => `${from}: ${subject}`;
