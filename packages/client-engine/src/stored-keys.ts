/**
 * THE REGISTRY OF STORED KEYS: everything a client or a server keeps under a name outside the
 * databases' own tables. Browser storage of every kind, cookies, cache and channel names, the
 * desktop's files, folders and keystore entries, the phone's secure store and database files, the
 * app identifiers and notification channels a system knows, and the names the product writes
 * into a person's mailbox.
 *
 * A name here is a promise. Another install, a device or a mailbox still holds what was written
 * under it, with no server in between, so a row is never renamed and its record never changes
 * shape; what is new gets a new name and a new row. Each row says where the name is written and
 * read, what it holds (never a value), whether that is a person's own words or mail, when it is
 * removed, and what the next major version does with it:
 *
 *  · `"kept"`: read and written as it is today.
 *  · `{ rewritten }`: read once under this name and written under the one named, which is a row.
 *  · `{ dropped }`: left unread, with the reason nothing of a person's is lost.
 *
 * A LEAF: it imports nothing, so any host may read it without the engine. The census
 * (`test/stored-keys-registry.test.ts`) holds it to the tree in both directions: every row's
 * spelling stands in the files it names, and every spelling the census reads as a stored name is
 * a row here that names its file, or is listed there as naming nothing stored. One name is
 * listed there and not here: the news folder's earlier one, which product source spells only in
 * its resolver.
 */

/** Where a name is kept. `identifier`: with the system, as the name it knows the app or one of its channels by. */
export type StoredKeyStore =
  | "localStorage" | "sessionStorage" | "indexedDB" | "cache" | "cookie" | "channel"
  | "secureStore" | "sqliteFile" | "file" | "keyring" | "identifier" | "mailbox";

/** Who writes it. `web` is the web shell wherever it runs: the browser, the desktop's window, the paired page. */
export type StoredKeyOwner =
  | "web" | "engine" | "server" | "desktop-window" | "paired-page" | "desktop-shell" | "desktop-engine"
  | "phone" | "organizer";

export interface StoredKeyRow {
  /** The name as it is spelled where it is kept. */
  key: string;
  /** The name is a prefix: every spelling that starts with it (an account, a mailbox, a composer follows). */
  family?: true;
  store: StoredKeyStore;
  owner: StoredKeyOwner;
  /**
   * The files that spell it. Every such file for a name kept on a device or in a cookie; for a
   * mailbox's folder and an app's identifier, which travel through the code as values, the files
   * that write it.
   */
  at: readonly string[];
  /** What is kept under it, in one line. Never a value. */
  holds: string;
  /** It holds a person's own words or their mail. Such a row is never dropped. */
  words: boolean;
  /**
   * What removes it. `sign-out`: signing out here, and so an erasure, which signs out too.
   * `account-erase`: the account's erasure alone. `both`: each by a path of its own. `never`:
   * neither; it stays, or it is spent where it is read.
   */
  erased: "sign-out" | "account-erase" | "both" | "never";
  mark: "kept" | { rewritten: string } | { dropped: string };
}

export const STORED_KEYS = [
  {
    key: "ohmail.theme", store: "localStorage", owner: "web",
    at: ["packages/ui/src/theme/ThemeProvider.tsx", "apps/webapp/app/(product)/providers.tsx", "apps/desktop/src/boot-stamp.ts", "apps/desktop/src/main.tsx", "apps/desktop/src/host-client/main.tsx"],
    holds: "the chosen appearance: light, dark or the system's",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.face", store: "localStorage", owner: "web",
    at: ["packages/ui/src/theme/ThemeProvider.tsx", "apps/desktop/src/boot-stamp.ts", "apps/desktop/src/host-client/main.tsx"],
    holds: "the chosen face of this device",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.face.account", store: "localStorage", owner: "web",
    at: ["packages/ui/src/theme/ThemeProvider.tsx", "apps/webapp/app/shell/face-mirror.ts", "apps/desktop/src/boot-stamp.ts", "apps/desktop/src/host-client/main.tsx"],
    holds: "the account's face as last read from the server, for the first paint",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.face.account.owner", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/face-mirror.ts"],
    holds: "which account the mirrored face belongs to",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.faceOffer", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/OhmarchyOffer.tsx", "apps/webapp/app/sign-out.ts"],
    holds: "that the face offer was dismissed on this device",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.layout", store: "localStorage", owner: "web",
    at: ["packages/ui/src/theme/ThemeProvider.tsx", "apps/desktop/src/boot-stamp.ts", "apps/desktop/src/host-client/main.tsx"],
    holds: "the chosen layout of the window",
    words: false, erased: "never", mark: { dropped: "the layout control is gone in 2.0; the key holds a look, nothing of a person's mail or words, and is left unread" },
  },
  {
    key: "ohmail.textSize", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/text-size.ts"],
    holds: "the chosen text size of this screen",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.locale", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/locale.ts"],
    holds: "the chosen language; the same name is the cookie a server render reads",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.locale", store: "cookie", owner: "web",
    at: ["apps/webapp/app/shell/locale.ts"],
    holds: "the chosen language, for a page rendered before any script runs",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.ui.columns", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "the two column widths of this machine",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.ui.rail.tagsOpen", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "whether the rail's Tags group is open",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.ui.rail.foldersOpen", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "whether the rail's Folders group is open",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.ui.search.sort.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "the search order last chosen, per account",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.rail.foldersOpened.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "which folders are open in the rail, per account (folder ids)",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.mail.original.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "which letters are shown in their original form, per account (message ids)",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.rail.foldersOpened", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "an earlier build's device-wide set of open folders; never read again, removed",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.mail.original", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/storage/persisted-ui.ts"],
    holds: "an earlier build's device-wide set of letters shown in original form; never read again, removed",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.reader.afterVerb", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/press/after-verb.ts"],
    holds: "what the reader does after a verb, per account; one more under the bare name, which stays",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.readingAlong.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/reading/reading-along.ts"],
    holds: "the reading-along intention, with the holder's machine name in it, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.compose.imageQuality", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/components/image-quality.ts"],
    holds: "the picture quality chosen for attachments, per account; one more under the bare name, which stays",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.ui.compose.imageShrink", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/components/image-quality.ts"],
    holds: "the same preference under the dial's earlier name and scale",
    words: false, erased: "account-erase", mark: { rewritten: "ohmail.ui.compose.imageQuality" },
  },
  {
    key: "ohmail.ui.compose.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/compose.ts"],
    holds: "an unfinished letter being written, per account and composer: a person's own words",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.compose", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/compose.ts"],
    holds: "an early build's scratch letter under no owner's name; no build reads it, every build removes it",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.compose.composer", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/shell/compose.ts"],
    holds: "which composer this tab is, an id",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.compose.session.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/compose.ts"],
    holds: "the name of the letter this composer is writing, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.compose.row.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/compose.ts"],
    holds: "the server's draft row this composer writes to, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.reply:", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/mail-send.ts"],
    holds: "an unfinished reply under no owner's name: a person's own words",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.replymeta:", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/mail-send.ts"],
    holds: "that reply's recipients and subject, under no owner's name",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.reply.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/mail-send.ts"],
    holds: "an unfinished reply, per account and lane: a person's own words",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.ui.replymeta.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/mail-send.ts"],
    holds: "that reply's recipients and subject, per account and lane",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.reply.panelHeight", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/shell/InlineReply.tsx"],
    holds: "the reply panel's height in this tab",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.send.locks.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/send-lock.ts"],
    holds: "the sends in flight and their keys, per account, so a reload resumes the same send",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.send.notes.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/mail-send.ts"],
    holds: "notes about a sent letter's copy, each naming a recipient and a subject, per account",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.screener.intents.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/screener-intents.ts"],
    holds: "Screener decisions pressed and not yet confirmed, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.delete.intents.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/press/delete-intents.ts"],
    holds: "deletes pressed and not yet confirmed, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.routing.intents.", family: true, store: "localStorage", owner: "engine",
    at: ["packages/client-engine/src/routing-intents.ts"],
    holds: "moves and rule presses not yet confirmed, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.screener.impersonationSeen.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/impersonation-filed.ts"],
    holds: "the newest filing this device acknowledged, an instant, per account",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.junkSweepDismissedAt", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/junk-window.ts"],
    holds: "the count a junk sweep offer was dismissed at, keyed by the account's mailbox ids",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.ui.seed.notNow.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/seed-offer.ts"],
    holds: "that the seed offer was put off, per account",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.access.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/doors/wall-lift.ts"],
    holds: "whether this device last found the account open or closed, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.accessHandoff", store: "sessionStorage", owner: "web",
    at: ["packages/app-logic/src/doors/wall-lift.ts"],
    holds: "that this tab left for the manage page: an account id and a time",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.lifecycle.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/api-client.ts", "apps/webapp/app/(product)/mailbox/LifecycleBanner.tsx"],
    holds: "that an account's catch-up notice was shown, per account",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.boot.", family: true, store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/session/boot-cache.ts"],
    holds: "the last answers the shell needs to paint before the server replies, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.erased", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/session/account-erased.ts"],
    holds: "the word to other tabs that the account was erased",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.signed-out", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/signed-out-signal.ts"],
    holds: "the word to other tabs that this browser signed out, where there is no channel; written and removed in one call",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.signed-out", store: "channel", owner: "web",
    at: ["apps/webapp/app/signed-out-signal.ts"],
    holds: "the same word, on a broadcast channel",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.signed-out-reason", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/resume/signed-out-note.ts"],
    holds: "why this tab was signed out, for its next page",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.signed-out-reason.shared", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/(product)/resume/signed-out-note.ts"],
    holds: "the same reason and a time, for the other tabs",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.revoke.owed.", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/(product)/resume/signed-out-note.ts"],
    holds: "a wipe this browser still owes after a revoke: a mark, a name and a time, never a token",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.resume.passes", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/resume/ResumeScreen.tsx"],
    holds: "how often this tab passed the resume splash",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.resume-attempted.", family: true, store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/resume/ResumeScreen.tsx"],
    holds: "that this tab tried to resume a session, per account",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.session.mintedAt", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "when this browser's jar last received a session",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.session.refreshAttempt", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "the name of a renewal sent and not yet adopted",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.session.lastAnswer", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "the mark of the newest session answer a live page saw, never the value",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.session.lateWatch.", family: true, store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "this tab's watch for a late renewal answer, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.session.splashOut", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "that the splash presented a renewal, for this tab's next page",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail-session", store: "indexedDB", owner: "web",
    at: ["apps/webapp/app/session-refresh.ts"],
    holds: "the durable copy of the renewal's name (stores `attempt` and `owed`), never a token",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.setup.offered", store: "sessionStorage", owner: "web",
    at: ["packages/app-logic/src/doors/setup-resume.ts"],
    holds: "that this tab was offered the setup",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.signup.plan", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/plan-hint.ts"],
    holds: "the plan a visitor chose before signing up",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.approve.request", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/approve/approval-return.ts"],
    holds: "the desktop sign-in request this tab is approving",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.oauth.landing", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/mailbox/oauth-return.ts"],
    holds: "where to land after a provider's sign-in returns",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.oauth.join", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/mailbox/oauth-return.ts"],
    holds: "how a provider's sign-in ended, for the page that reads it",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.oauth.owner.", family: true, store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/mailbox/oauth-return.ts"],
    holds: "which account started a provider's sign-in, per state value",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.deviceCeremony", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/(product)/mailbox/MailboxSection.tsx", "apps/webapp/app/sign-out.ts"],
    holds: "the lookup key of a device sign-in in progress, not a credential",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.desktopCtaDismissed", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/AppShell.tsx"],
    holds: "that the desktop prompt was dismissed",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.updateAsked", store: "localStorage", owner: "web",
    at: ["packages/app-logic/src/doors/app-update.ts"],
    holds: "which update this device was already asked about",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.demo-ribbon", store: "sessionStorage", owner: "web",
    at: ["apps/webapp/app/shell/AppShell.tsx", "apps/webapp/app/shell/shell-open-state.ts"],
    holds: "that the demo ribbon was dismissed in this tab",
    words: false, erased: "never", mark: { dropped: "the demo world is not part of 2.0; the key marks a dismissed ribbon and nothing else" },
  },
  {
    key: "ohmail.notifications.channels", store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/notification-settings.ts"],
    holds: "which notification channels are switched on, on this device",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.notifications.subscription", family: true, store: "localStorage", owner: "web",
    at: ["apps/webapp/app/shell/notification-settings.ts"],
    holds: "this browser's push registration: the row's id, its endpoint and the account it was made for",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail-notify-v1", store: "cache", owner: "web",
    at: ["apps/webapp/app/shell/notification-settings.ts", "apps/webapp/public/sw.js"],
    holds: "the words the page leaves its service worker for a notification",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.intent-windows", store: "channel", owner: "web",
    at: ["packages/app-logic/src/press/intent-windows.ts"],
    holds: "the channel on which tabs tell each other about open intent windows",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.join.handoff", store: "channel", owner: "web",
    at: ["apps/webapp/app/(product)/join/handoff.ts"],
    holds: "the channel on which the join page hands over to the tab that opened it",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "tf_signed_out", store: "cookie", owner: "web",
    at: ["apps/webapp/app/session-gate.ts"],
    holds: "the reason's word for 15 s after a refusal emptied the jar",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-mirror:", family: true, store: "indexedDB", owner: "engine",
    at: ["packages/client-engine/src/idb.ts"],
    holds: "one account's device copy of its mail: records, the outbox of queued acts, the sync cursor (`cursor`), its owner (`__owner`) and its generation (`__gen`)",
    words: true, erased: "both", mark: "kept",
  },
  {
    key: "ohmail-mirror", store: "indexedDB", owner: "engine",
    at: ["packages/client-engine/src/idb.ts", "apps/webapp/app/(product)/mailbox/CloudShell.tsx"],
    holds: "the one un-owned device copy every early build opened; deleted once, never opened",
    words: false, erased: "both", mark: "kept",
  },
  {
    key: "ohmail.mirror.", family: true, store: "localStorage", owner: "engine",
    at: ["packages/client-engine/src/idb.ts"],
    holds: "the names of the device copies this origin opened, so a sign-out can delete them where the browser lists none",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.outbox.", family: true, store: "channel", owner: "engine",
    at: ["packages/client-engine/src/outbox-notices.ts"],
    holds: "the channel on which windows of one device copy tell each other the queue changed",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-mirror:", family: true, store: "sqliteFile", owner: "phone",
    at: ["packages/client-engine/src/idb.ts"],
    holds: "the same copy on the phone, one SQLite file per account. The file is named by this name encoded (`dbFileName`, apps/mobile/src/engine/boot.ts: each character outside A-Z a-z 0-9 . - as `_<hex>_`, then `.db`) and opened in apps/mobile/src/engine/native.ts",
    words: true, erased: "both", mark: "kept",
  },
  {
    key: "tf_session", store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "packages/api/src/middleware.ts", "packages/api/src/routes/shared-cloud.ts", "apps/webapp/app/session-gate.ts", "apps/sidecar/src/cloud-signin.ts"],
    holds: "the session's access token; host-only, HttpOnly; also read as `__Host-tf_session`",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "tf_refresh", store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "packages/api/src/routes/session-lifecycle.ts", "apps/sidecar/src/cloud-signin.ts"],
    holds: "the session's refresh token, scoped to the refresh path; also read as `__Host-tf_refresh`",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "tf_csrf", store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "packages/api/src/middleware.ts", "apps/webapp/app/csrf.ts", "packages/client-engine/src/adapters/http-adapter.ts"],
    holds: "the double-submit token a script reads and echoes",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "tf_resume", store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "packages/api/src/routes/session-lifecycle.ts", "packages/api/src/routes/shared-cloud.ts", "apps/webapp/app/session-gate.ts"],
    holds: "that this browser may have a session to resume",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "tf_owner", store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "packages/app-logic/src/storage/owner-cookie.ts"],
    holds: "the account id the jar belongs to, readable by script, never a credential",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "__Host-", family: true, store: "cookie", owner: "server",
    at: ["packages/api/src/cookies.ts", "apps/sidecar/src/cloud-signin.ts", "packages/app-logic/src/storage/cookie-jar.ts", "packages/client-engine/src/adapters/http-adapter.ts"],
    holds: "the prefix under which each session cookie is also set and read",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.desktop.cloudScope", store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/window-sweep.ts"],
    holds: "the mailbox a Cloud door last showed, so a revoke heard at launch shows its card first",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.window.sent-folders.", family: true, store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/window-outbox-store.ts"],
    holds: "a mailbox's recorded Sent folders, per account",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.desktopDefaultMailAsked", store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/DesktopDefaultMail.tsx"],
    holds: "that the default-mail-app question was answered",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.diagnostics.install", store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/local-diagnostics.ts"],
    holds: "a random identity of this install, for diagnostic files",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.first-run.ai", store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/local-first-run.ts"],
    holds: "the answer to the first-run AI question",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.omarchy.palette", store: "localStorage", owner: "desktop-window",
    at: ["apps/desktop/src/omarchy-paint.ts"],
    holds: "the last good system palette, for the first paint",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.host.refreshToken", store: "localStorage", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "the pairing's refresh token",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.host.pairScope", store: "localStorage", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "which account this pairing opens, so its copy keeps one owner",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.host.refreshAttempt", store: "localStorage", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "the name of a rotation sent and not yet adopted",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.host.refreshAttemptOwed", store: "localStorage", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "that name, owed for the token it went out with: an id, a mark and a time",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.host.signOutsOwed", store: "localStorage", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "sign-outs the computer was not told yet: a refresh token each, sent to the sign-out door only",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-host-session", store: "indexedDB", owner: "paired-page",
    at: ["apps/desktop/src/host-client/bearer.ts"],
    holds: "the durable copy of the rotation's name (stores `attempt` and `owed`)",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail-host-outbox", store: "indexedDB", owner: "paired-page",
    at: ["apps/desktop/src/host-client/outbox-store.ts"],
    holds: "the acts this page queued and has not yet sent",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "config.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "which door this install opens and where its server is",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "host.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "whether this computer serves its phone page, and how",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "door-switch.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "a switch between doors that is under way",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "mirror-owner", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs", "apps/sidecar/src/cloud-engine.ts"],
    holds: "which account the copy on this computer belongs to",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "cloud-ca.pem", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs", "apps/sidecar/src/cloud-origin.ts"],
    holds: "a certificate authority the operator of this install's server named",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "cloud-ca.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "the record of where that certificate authority came from",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "engine-candidate", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "the folder a downloaded engine waits in before it is taken into use",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "install-key", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "this install's key for what it keeps encrypted, where no keystore holds it or beside the keystore's copy",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "install-key", store: "keyring", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the same key in the system keystore, under the service `ohmail`",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "kek.v1", store: "keyring", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "that key under its first name, in the service `io.ohmail.desktop`",
    words: false, erased: "never", mark: { rewritten: "install-key" },
  },
  {
    key: "engine.log", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the engine's log lines",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "stderr.log", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/last_words.rs"],
    holds: "what the engine last wrote to its error stream",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "engine.hold", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "that the shell holds the data folder for an engine it is starting",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "running.marker", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/unclean_exit.rs"],
    holds: "that the app is running, so the next start can tell an unclean exit",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-diagnostics.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs", "packages/core/src/diagnostics/bundle.ts"],
    holds: "a diagnostic file a person asked for, saved where they chose",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "opened", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the folder an attachment is saved in before it is opened",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "update-staged.json", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/appimage_stage.rs"],
    holds: "the record of an update downloaded and waiting",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "update-install", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/appimage_stage.rs"],
    holds: "the choice of when updates install",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "update-failed", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/appimage_stage.rs"],
    holds: "that the last update did not install",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "window-canvas", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/launch_window.rs"],
    holds: "the window's background colour at its last close, for the next launch",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "text-size", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/text_scale.rs"],
    holds: "the text size the window was last given",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "engine-local", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "the folder everything of a door that organizes on this computer is kept in: its store, its locks and its files",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "engine-cloud", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "the folder everything of a door onto an account's server is kept in: the copy, its cursor and the sealed session",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: ".replaced", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/config.rs"],
    holds: "the ending of a door's folder set aside whole while a switch to another door is not settled (`engine-cloud.replaced`)",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail", store: "keyring", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the service the install's key is filed under in the system keystore; its entry is `install-key`",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-preview", store: "keyring", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the same service for a preview build, which runs beside a released install and never reads or writes that install's key",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: ".old", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/engine.rs"],
    holds: "the ending of the engine log's one earlier generation (`engine.log.old`)",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "logs", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/last_words.rs"],
    holds: "the folder the error stream's file is kept in on Linux, beside the engine's log",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "log.old", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/last_words.rs"],
    holds: "the ending of the error stream's one earlier generation (`stderr.log.old`)",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "log.old.partial", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/last_words.rs"],
    holds: "that earlier generation while it is being written",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: ".ohmail-update", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/appimage_stage.rs"],
    holds: "a downloaded release staged beside the app's own image, as `.<image name>.ohmail-update`",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: ".part", store: "file", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/appimage_stage.rs"],
    holds: "the ending of a staged release while its bytes are still being written",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "pgdata", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts", "apps/desktop/src-tauri/src/engine.rs"],
    holds: "the engine's store: the mail, rules and settings of the accounts on this computer",
    words: true, erased: "account-erase", mark: "kept",
  },
  {
    key: "set-aside-", family: true, store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts", "apps/desktop/src-tauri/src/engine.rs"],
    holds: "a store moved aside rather than deleted, with its time in the name",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "sidecar.lock", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts", "apps/desktop/src-tauri/src/engine.rs"],
    holds: "that one engine has the data folder open",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "sidecar.hold", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts"],
    holds: "that the data folder is held for an engine about to start",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "store-generation.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts"],
    holds: "which run of the store this is, so a cursor of an ended run is refused",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "store-unfinished", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/db.ts"],
    holds: "that a store was being made and is not finished",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ai-provider.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/ai-provider.ts"],
    holds: "which model provider this install uses, with its key sealed",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "first-door-attempt.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/first-door.ts"],
    holds: "a first sign-in under way",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "cloud-session.marker", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/cloud-auth.ts"],
    holds: "that this install holds a session with its account's server",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "cloud-session-refused.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/cloud-engine.ts"],
    holds: "that the account's server refused this install's session, and when",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "cloud-bootstrap-gen.marks", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/cloud-mirror.ts"],
    holds: "which run of the copy each first fill belongs to",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "window-outbox.", family: true, store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/window-outbox.ts"],
    holds: "the acts a window queued and has not yet sent, one file per account and server",
    words: true, erased: "sign-out", mark: "kept",
  },
  {
    key: "window-outbox.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/window-outbox.ts"],
    holds: "the one such file builds wrote before the files named their owner",
    words: true, erased: "sign-out", mark: { rewritten: "window-outbox." },
  },
  {
    key: "window-outbox.unowned.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/window-outbox.ts"],
    holds: "a legacy file no owner could be established for: kept, logged, never served",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "lan-door.key.pem", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/host-lan-tls.ts"],
    holds: "the private key of this computer's door on the local network",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "lan-door.cert.pem", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/host-lan-tls.ts"],
    holds: "that door's certificate",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "host-door.cert.pem", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/host-pin-probe.ts"],
    holds: "the certificate a paired phone pins",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "cloud-tokens.seal", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/cloud-engine.ts", "apps/desktop/src-tauri/src/config.rs"],
    holds: "this install's session with its account's server, sealed under the install's key",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "cloud-cursor.json", store: "file", owner: "desktop-engine",
    at: ["apps/sidecar/src/cloud-engine.ts", "apps/desktop/src-tauri/src/engine.rs"],
    holds: "where the copy on this computer stands in its account's feed; set aside with the store it names a point in, removed when the copy's mail is taken off this computer",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.servers.v1", family: true, store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/servers.ts"],
    holds: "the phone's pairings: an index, one record per server with its refresh token, the sign-outs and wake removals it still owes, and the mark of an engine removal under way",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.engine.kek.v1", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/engine/kek.ts"],
    holds: "the key the phone's own engine seals a mailbox's password with",
    words: false, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail.locale", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/i18n/store.ts"],
    holds: "the chosen language",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.appearance", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/appearance-store.ts"],
    holds: "the chosen appearance and face",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.access", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/access-verdict.ts"],
    holds: "whether this phone last found the account open or closed",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.compose.pictureQuality", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/picture-quality-store.ts"],
    holds: "the picture quality chosen for attachments",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.screener.impersonationSeen", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/impersonation-seen-store.ts"],
    holds: "the newest filing this phone acknowledged, an instant",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.seed.notNow.", family: true, store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/seed-offer.ts"],
    holds: "that the seed offer was put off, per account",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.delete.intents.local", store: "sqliteFile", owner: "phone",
    at: ["apps/mobile/src/state/held-delete.ts"],
    holds: "deletes pressed and not yet confirmed, a row of the account's own copy",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "ohmail.diagnostics.install", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/engine/diagnostics.ts"],
    holds: "a random identity of this install, for diagnostic files",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.organizer.notification.asked", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/engine/notification-permission-native.ts"],
    holds: "that this install asked for the notification permission once",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail-engine.db", store: "sqliteFile", owner: "phone",
    at: ["apps/mobile/src/engine/local-engine.ts"],
    holds: "the phone's own engine store: the mail, rules and settings of a mailbox it organizes itself",
    words: true, erased: "account-erase", mark: "kept",
  },
  {
    key: "ohmail-install", store: "sqliteFile", owner: "phone",
    at: ["apps/mobile/src/state/install-marker.ts"],
    holds: "the install's marker (one row, `generation`), which tells a fresh install from a restored one",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.face.account", store: "secureStore", owner: "phone",
    at: ["apps/mobile/src/state/face-scope.ts"],
    holds: "the account's look as this phone last adopted it, with the account it belongs to",
    words: false, erased: "sign-out", mark: "kept",
  },
  {
    key: "io.ohmail.desktop", store: "identifier", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/src/engine.rs", "apps/desktop/src-tauri/src/default_mail.rs"],
    holds: "the desktop app's identifier: its data folder, its keystore service of old, its bundle id",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "io.ohmail.preview", store: "identifier", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/variant.rs"],
    holds: "a preview build's identifier: its own data and log folders, apart from a released install's",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "app.ohmail", store: "identifier", owner: "phone",
    at: ["apps/mobile/app.json"],
    holds: "the phone app's identifier on both systems",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "ohmail.mailto", store: "identifier", owner: "desktop-shell",
    at: ["apps/desktop/src-tauri/src/default_mail.rs"],
    holds: "the name under which Windows knows ohmail as a mail handler",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "organizing", store: "identifier", owner: "phone",
    at: ["apps/mobile/modules/organizer-service/android/src/main/java/app/ohmail/organizer/OrganizerService.kt"],
    holds: "the Android notification channel of the organizing notice; the system keeps a person's settings for it under this id",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "app.ohmail.push.new_mail", store: "identifier", owner: "phone",
    at: ["apps/mobile/plugins/wake-push-renderer.js"],
    holds: "the Android notification channel of new mail; the system keeps a person's settings for it under this id",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "INBOX", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts"],
    holds: "the mailbox's own inbox: letters let in",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/Screener", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts", "packages/core/src/away-scope.ts"],
    holds: "the folder a first-time sender's letters wait in",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/News", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts"],
    holds: "the folder newsletters are filed in; a mailbox last organized before 0.22 holds it under an earlier name, which the organizer renames on its next pass",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/Receipts", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts"],
    holds: "the folder receipts are filed in",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/Screened", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts"],
    holds: "the folder a screened-out sender's letters are filed in",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/Quarantine", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/types.ts"],
    holds: "the folder a letter judged spam was filed in",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "Sent", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/adapters/imap.ts"],
    holds: "the folder a sent letter's copy is filed in, created only in a mailbox that has no Sent folder of its own",
    words: true, erased: "never", mark: "kept",
  },
  {
    key: "ohmail/_meta", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/adapters/organizer-lease.ts"],
    holds: "the unsubscribed folder holding the organizer's claim, the requests sent to it and the settings profile",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "X-Ohmail-", family: true, store: "mailbox", owner: "organizer",
    at: ["packages/core/src/adapters/organizer-lease.ts", "packages/core/src/adapters/organizer-profile.ts"],
    holds: "the header fields of those records: the claim (lease, install, heartbeat, kind, capabilities), a request and its answer, the profile and its version",
    words: false, erased: "never", mark: "kept",
  },
  {
    key: "Subject: ohmail settings for this mailbox", store: "mailbox", owner: "organizer",
    at: ["packages/core/src/adapters/organizer-profile.ts"],
    holds: "the subject of the settings profile's message in `ohmail/_meta`",
    words: false, erased: "never", mark: "kept",
  },
] as const satisfies readonly StoredKeyRow[];

/** Every registered name. A family's name stands for every spelling that starts with it. */
export type StoredKey = (typeof STORED_KEYS)[number]["key"];
