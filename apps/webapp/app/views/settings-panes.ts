import type { PaneId } from "../shell/routing";

/**
 * WHICH PANES THIS SURFACE OFFERS, as booleans. The record is deliberately TOTAL: a pane added
 * to {@link settingsPanes} widens this type, and every caller refuses to compile until it
 * answers the new flag — that is how a new tab is registered in the nav AND the palette by
 * construction. `SettingsView` answers from node presence (absent node ⇒ no pane, structurally);
 * `AppShell` answers from the same facts its section props encode.
 */
export interface WiredPanes {
  mailboxes: boolean;
  screener: boolean;
  ai: boolean;
  away: boolean;
  rules: boolean;
  folders: boolean;
  signatures: boolean;
  /** The desktop pane carries its own label (host mode names it); `null` ⇒ no pane. */
  desktop: string | null;
  devices: boolean;
  billing: boolean;
  invites: boolean;
  security: boolean;
  account: boolean;
  about: boolean;
}

/**
 * The settings tabs, in the nav's own reading order — client basics → mail plumbing → account
 * administration → facts. ONE list for the nav and the ⌘K palette, so the two cannot disagree.
 * The placements are arguments: Screener after Mailboxes (it is about the mail a connection
 * brings); AI and Away beside it (all three act on mail unprompted, and Away — the one control
 * that makes the app SEND mail on its own — earns a named entry); Rules BEFORE Tags (the product
 * made the rule on the reader's behalf, so it has to be findable); the desktop install ahead of
 * the account group (on that surface it IS the account); Security and Account near the bottom,
 * where a mis-click is not one row from a mail setting; About last — it acts on nothing.
 * `t` is scoped to the `settings` namespace, the nav labels' home.
 */
export function settingsPanes(w: WiredPanes, t: (key: string) => string): Array<[PaneId, string]> {
  return [
    ["general", t("general")],
    ["notifications", t("notifications")],
    ...(w.mailboxes ? [["mailboxes", t("mailboxes")] as [PaneId, string]] : []),
    ...(w.screener ? [["screener", t("screener")] as [PaneId, string]] : []),
    ...(w.ai ? [["ai", t("ai")] as [PaneId, string]] : []),
    ...(w.away ? [["away", t("away")] as [PaneId, string]] : []),
    ...(w.rules ? [["rules", t("rules")] as [PaneId, string]] : []),
    ["tags", t("tags")],
    ...(w.folders ? [["folders", t("folders.nav")] as [PaneId, string]] : []),
    ...(w.signatures ? [["signatures", t("signatures.nav")] as [PaneId, string]] : []),
    ...(w.desktop !== null ? [["desktop", w.desktop] as [PaneId, string]] : []),
    ...(w.devices ? [["devices", t("devices")] as [PaneId, string]] : []),
    ...(w.billing ? [["billing", t("billing")] as [PaneId, string]] : []),
    ...(w.invites ? [["invites", t("invites")] as [PaneId, string]] : []),
    ...(w.security ? [["security", t("security")] as [PaneId, string]] : []),
    ...(w.account ? [["account", t("account")] as [PaneId, string]] : []),
    ...(w.about ? [["about", t("about")] as [PaneId, string]] : []),
  ];
}
