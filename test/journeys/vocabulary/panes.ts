/**
 * Which Settings sections each setting lists, as today's app shows them. Read on the running app,
 * signed in to an account with one mailbox, the server saying it offers pairing and fetches pictures
 * and metering nothing. This is the table the Settings journeys hold the app to, as a set: where a
 * section stands in the menu is not held.
 *
 * W-m: the bench's server meters nothing and its build names no storage project, so Subscription and
 * Storage were not read here. They are unread, not absent from the managed app.
 */
export const PANES_SEEN = {
  "W-m": [
    "general", "notifications", "mailboxes", "screener", "ai", "away", "rules", "tags", "folders", "signatures",
    "devices", "security", "account", "about", "help",
  ],
  "W-s": [
    "general", "notifications", "mailboxes", "screener", "ai", "away", "rules", "tags", "folders", "signatures",
    "devices", "invites", "security", "account", "about",
  ],
  "W-d": ["general", "notifications", "rules", "tags", "about"],
} as const;

export type WebSetting = keyof typeof PANES_SEEN;
export const listsPane = (setting: string, pane: string): boolean =>
  setting in PANES_SEEN && (PANES_SEEN[setting as WebSetting] as readonly string[]).includes(pane);

/**
 * The page a desktop serves to a phone's browser (H), paired to an engine with one mailbox:
 * read by `apps/desktop/test/journeys-host.test.ts`.
 */
export const HOST_PANES = ["general", "notifications", "screener", "rules", "tags", "signatures", "account"] as const;
