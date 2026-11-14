/**
 * WHAT IS KNOWN OF EACH SECTION before any pane is built: its group, its sign, its name and when the host lists it.
 * The groups are the shipped menu's three; the signs are the design's; the names are the shipped catalogue's keys.
 */
import { panesOf, type HostContract } from "../host/index.js";
import type { PaneGroup, PaneId, SettingsPane } from "./contract.js";
import { SETTINGS_MENU_NAMESPACE } from "./namespace.js";

export type PaneFacts = Pick<SettingsPane, "group" | "icon" | "label" | "listed">;

const said = (key: string) => ({ namespace: "settings", key });
const always = () => true;
const byHost = (id: Exclude<PaneId, "general" | "notifications" | "tags">) => (host: HostContract) =>
  panesOf(host)[id];
const fact = (
  group: PaneGroup,
  icon: PaneFacts["icon"],
  label: PaneFacts["label"],
  listed: PaneFacts["listed"],
) => ({ group, icon, label, listed }) as const;

export const PANE_FACTS: Readonly<Record<PaneId, PaneFacts>> = {
  general: fact("mail", "settings", said("general"), always),
  notifications: fact("mail", "bell", said("notifications"), always),
  mailboxes: fact("mail", "mail", said("mailboxes"), byHost("mailboxes")),
  screener: fact("mail", "screener", said("screener"), byHost("screener")),
  ai: fact("mail", "spark", said("ai"), byHost("ai")),
  away: fact("mail", "reply", said("away"), byHost("away")),
  rules: fact("mail", "go", said("rules"), byHost("rules")),
  tags: fact("mail", "tags", said("tags"), always),
  folders: fact("mail", "folder", said("folders.nav"), byHost("folders")),
  signatures: fact("mail", "write", said("signatures.nav"), byHost("signatures")),
  desktop: fact("mail", "desktop", { namespace: SETTINGS_MENU_NAMESPACE, key: "desktop" }, byHost("desktop")),
  devices: fact("account", "phone", said("devices"), byHost("devices")),
  billing: fact("account", "receipts", said("billing"), byHost("billing")),
  storage: fact("account", "disk", said("storage"), byHost("storage")),
  invites: fact("account", "user", said("invites"), byHost("invites")),
  security: fact("account", "shield", said("security"), byHost("security")),
  account: fact("account", "key", said("account"), byHost("account")),
  about: fact("about", "info", said("about"), byHost("about")),
  help: fact("about", "send", said("help"), byHost("help")),
};

/** A section's registration from its facts: what a pane's task hands over is its body, and what it says in the menu. */
export function paneOf(id: PaneId, own: Pick<SettingsPane, "Body" | "useSummary">): SettingsPane {
  return { id, ...PANE_FACTS[id], ...own };
}
