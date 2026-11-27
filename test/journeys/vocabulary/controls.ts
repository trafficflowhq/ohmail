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
  /** Password inputs have a label but no implicit ARIA role. */
  byLabel?: true;
  nameSuffix?: CatalogueKey;
  /** The composite name of a search result starts with its sender and includes its subject. */
  searchResult?: true;
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
  // The rail is the frame's own, drawn from the places' registrations: its landmark is the frame's word.
  c("rail", "navigation", "frame.landmark.places"),
  c("rail-compose", "button", "frame.dock.write", { within: "rail" }),
  c("rail-ohbox", "button", "ohbox.title", { within: "rail", counted: true }),
  c("rail-reads", "button", "news.title", { within: "rail", counted: true }),
  c("rail-receipts", "button", "receipts.title", { within: "rail", counted: true }),
  c("rail-screener", "button", "screener.title", { within: "rail", counted: true }),
  c("rail-reply-later", "button", "later.title", { within: "rail", counted: true }),
  c("rail-set-aside", "button", "parked.title", { within: "rail", counted: true }),
  c("rail-resurface", "button", "resurface.title", { within: "rail", counted: true }),
  c("rail-history", "button", "history.title", { within: "rail" }),
  c("rail-search", "button", "search.title", { within: "rail" }),
  c("rail-drafts", "button", "drafts.title", { within: "rail", counted: true }),
  c("rail-trash", "button", "trash.title", { within: "rail", counted: true }),
  c("rail-settings", "button", "settings.title", { within: "rail" }),
  c("demo-dismiss", "button", "ribbon.dismiss"),

  // Lists and their rows.
  c("list-new", "listbox", "ohbox.newForYou", { within: "content" }),
  c("list-earlier", "listbox", "ohbox.previouslySeen", { within: "content" }),
  c("list-reads", "listbox", "news.list.label", { within: "content" }),
  c("list-receipts", "listbox", "receipts.list.label", { within: "content" }),
  c("list-screener", "listbox", "screener.title", { within: "content" }),
  c("list-triage", "listbox", "triage.title", { within: "content" }),
  c("list-history", "listbox", "history.title", { within: "content" }),
  c("list-drafts", "listbox", "drafts.title", { within: "content" }),
  c("list-scheduled", "listbox", "drafts.scheduledTitle", { within: "content" }),
  c("trash-region", "region", "frame.landmark.list", { within: "content" }),
  c("list-trash", "listbox", "trash.title", { within: "trash-region" }),
  c("trash-letter", "option", null, { within: "list-trash", nameFrom: "visible" }),
  c("conversation", "option", null, { within: "content", nameFrom: "visible" }),
  c("mark-all-read", "button", "markAll.aria", { within: "content" }),

  // The open message.
  c("reader", "region", "reader.pane"),
  c("reader-subject", "heading", null, { within: "reader", nameFrom: "visible" }),
  c("letter", "article", null, { within: "reader", nameFrom: "none" }),
  c("reply", "button", "reader.verb.reply", { within: "reader" }),
  c("forward", "button", "message.menuForward", { within: "reader" }),
  c("mark-unread", "button", "reader.verb.markUnread", { within: "reader" }),
  c("more", "button", "reader.verb.more", { within: "reader" }),
  c("reader-more", "menu", "reader.verb.more"),
  c("delete-letter", "menuitem", "reader.verb.delete", { within: "reader-more" }),
  c("undo", "button", "screener.toastUndo"),
  c("park", "button", "reader.verb.aside", { within: "reader" }),
  c("later", "button", "reader.verb.later", { within: "reader" }),
  c("images-blocked", "button", "mailBody.imagesCaption", { within: "content" }),
  c("show-original", "button", "mailBody.design", { within: "content" }),
  c("show-as-text", "button", "mailBody.plain", { within: "content" }),
  c("reply-send", "button", "reply.send", { within: "reader" }),
  c("reply-body", "textbox", "write.reply.text", { within: "reader" }),

  // Compose.
  c("compose-letter", "region", "write.letter"),
  // Write's letter: its people and its subject as the kit's Write names them (`write.to`, `write.subject`).
  c("compose-to", "combobox", "write.to", { within: "content" }),
  c("compose-subject", "textbox", "write.subject", { within: "content" }),
  // Write's letter names its text as the kit's Write draws it (`write.text`).
  c("compose-body", "textbox", "write.text", { within: "content" }),
  c("compose-send", "button", "write.send", { within: "content" }),
  c("compose-later", "button", "write.later.verb", { within: "content" }),
  c("compose-later-menu", "dialog", "write.later.title"),
  c("compose-restore", "button", "compose.restoreDraft"),
  c("reload-update", "button", "update.lineReloadAction"),
  c("compose-cancel", "button", "write.discard", { within: "compose-letter" }),
  c("compose-bold", "button", "write.marks.bold", { within: "content" }),

  // Search.
  c("search-box", "textbox", "search.aria", { within: "content" }),
  c("search-results", "list", "search.aria", { within: "content" }),
  c("search-result", "listitem", null, { within: "search-results", nameFrom: "none" }),
  c("search-hit", "button", null, { within: "search-result", nameFrom: "visible", searchResult: true }),

  // The Screener.
  c("screener-sections", "group", "screener.segAria", { within: "content" }),
  c("screener-waiting", "button", "screener.segWaiting", { within: "screener-sections", counted: true }),
  c("screener-screened", "button", "screener.segScreened", { within: "screener-sections", counted: true }),
  c("screener-spam", "button", "screener.segSpam", { within: "screener-sections", counted: true }),
  c("screener-junk", "button", "screener.segJunk", { within: "screener-sections" }),
  c("screener-destinations", "menu", "screener.rowMoreAria", { within: "content" }),

  // Triage.
  c("triage-piles", "group", "later.switch.label", { within: "content" }),
  c("triage-reply-later", "button", "later.title", { within: "triage-piles", counted: true }),
  c("triage-set-aside", "button", "parked.title", { within: "triage-piles", counted: true }),
  c("triage-resurface", "button", "resurface.title", { within: "triage-piles", counted: true }),

  // Mail and Calendar.
  c("products", "group", "frame.products.label"),
  c("switch-calendar", "button", "frame.products.cal", { within: "products" }),
  c("switch-mail", "button", "frame.products.mail", { within: "products" }),

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
  c("notify-news", "switch", "settings.channel.reads.label", { within: "settings-pane" }),
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
  c("rail-tags", "button", "tags.title", { within: "rail" }),
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
  c("erase-open", "button", "account.begin", { within: "settings-pane" }),
  c("erase-begin", "button", "deleteAccount.begin"),
  c("erase-confirm", "textbox", "deleteAccount.typeLabel"),

  // The doors.
  c("login-email", "textbox", "login.emailLabel"),
  c("login-password", "textbox", "login.passwordLabel", { byLabel: true }),
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
