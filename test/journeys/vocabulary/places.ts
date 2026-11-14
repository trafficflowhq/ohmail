import type { CatalogueKey } from "./catalogue.js";

/**
 * The places of the app a journey can be in. A place has the address that reaches it and the one
 * thing on screen that says "you are here", by role and catalogue key. The route strings live here
 * and nowhere else; `guards.test.ts` holds each against the router's own lists.
 */
export type AriaRole =
  | "heading" | "navigation" | "main" | "region" | "listbox" | "option" | "button" | "link" | "tab" | "tablist"
  | "textbox" | "combobox" | "group" | "status" | "alert" | "dialog" | "menu" | "menuitem" | "article" | "toolbar"
  | "separator" | "switch" | "checkbox" | "radio" | "form" | "note" | "feed" | "list";

export interface Place {
  id: string;
  /** `#/…` for a place inside the shell, a path for a door. */
  route: string;
  landmark: { role: AriaRole; key: CatalogueKey };
}

const view = (id: string, key: CatalogueKey): Place => ({ id, route: `#/${id}`, landmark: { role: "heading", key } });
/** A Settings pane is told by its entry in the Settings menu being the current one. */
const pane = (id: string, key: CatalogueKey): Place => ({
  id: `settings-${id}`, route: `#/settings/${id}`, landmark: { role: "button", key },
});

export const PLACES = {
  ohbox: view("ohbox", "ohbox.title"),
  reads: view("reads", "reads.title"),
  receipts: view("receipts", "receipts.title"),
  screener: view("screener", "screener.title"),
  triage: view("triage", "triage.title"),
  history: view("history", "history.title"),
  search: view("search", "search.title"),
  compose: view("compose", "compose.title"),
  drafts: view("drafts", "drafts.title"),
  trash: view("trash", "rail.trash"),
  settings: view("settings", "settings.title"),

  "settings-general": pane("general", "settings.general"),
  "settings-notifications": pane("notifications", "settings.notifications"),
  "settings-mailboxes": pane("mailboxes", "settings.mailboxes"),
  "settings-screener": pane("screener", "settings.screener"),
  "settings-ai": pane("ai", "settings.ai"),
  "settings-away": pane("away", "settings.away"),
  "settings-billing": pane("billing", "settings.billing"),
  "settings-storage": pane("storage", "settings.storage"),
  "settings-invites": pane("invites", "settings.invites"),
  "settings-tags": pane("tags", "settings.tags"),
  "settings-rules": pane("rules", "settings.rules"),
  "settings-folders": pane("folders", "settings.folders.nav"),
  "settings-signatures": pane("signatures", "settings.signatures.nav"),
  "settings-about": pane("about", "settings.about"),
  "settings-help": pane("help", "settings.help"),
  "settings-security": pane("security", "settings.security"),
  "settings-account": pane("account", "settings.account"),
  "settings-desktop": pane("desktop", "desktopDoor.paneLabel"),
  "settings-devices": pane("devices", "settings.devices"),

  /** The open message: reached by opening a conversation, never by an address of its own. */
  reader: { id: "reader", route: "#/ohbox", landmark: { role: "region", key: "reader.pane" } },

  /** The doors. */
  gate: { id: "gate", route: "/login", landmark: { role: "heading", key: "login.title" } },
  "first-run": { id: "first-run", route: "/", landmark: { role: "list", key: "join.progress" } },
  "sign-out": { id: "sign-out", route: "#/settings/account", landmark: { role: "button", key: "account.signOut" } },
  erase: { id: "erase", route: "#/settings/account", landmark: { role: "button", key: "account.begin" } },
} as const satisfies Record<string, Place>;

export type PlaceId = keyof typeof PLACES;

/** The Settings panes, by the id the router gives them. */
export const PANE_PLACES = Object.keys(PLACES).filter((id) => id.startsWith("settings-")) as PlaceId[];
export const paneIdOf = (place: PlaceId): string => PLACES[place].route.replace("#/settings/", "");
