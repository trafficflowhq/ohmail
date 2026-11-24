/** @vitest-environment jsdom */
/**
 * EVERY FAMILY THE WEB KEEPS IN A BROWSER'S STORAGE IS BUILT FROM A SCOPE HANDED IN, derived from the registry of
 * stored keys and not remembered: each family a web view keeps is spelled by a builder that takes the scope as a
 * required argument (called here with an account and with none, and refusing a scope nobody handed in), or it is one
 * of the hosts' own families, each with its reason. A family that arrives with neither is red here, and so is a
 * builder that reads a scope nobody handed in as `local`.
 *
 * Beside the registry's own census, because the registry is read by its path (`STORED_KEYS`, a data export the web
 * app's tests do not reach). The names themselves, for an account and for none, stand in
 * `apps/webapp/test/storage-owner-scopes-every-door.test.tsx`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { STORED_KEYS } from "../packages/client-engine/src/stored-keys.js";
import { routingIntentsKey } from "@ohmail/client-engine";
import { unsubscribeSeenKey } from "@ohmail/app-logic/screener";
import { composeDraftKey, composeRowKey, composeSessionKey } from "@ohmail/app-logic/writing/compose";
import { replyDraftKey, replyMetaKey, sentCopyNotesKey } from "@ohmail/app-logic/writing/mail-send";
import { sendLocksKey } from "@ohmail/app-logic/writing/send-lock";
import { screenerIntentsKey } from "@ohmail/app-logic/screener/screener-intents";
import { impersonationSeenKey } from "@ohmail/app-logic/screener/impersonation-filed";
import { deleteIntentsKey } from "@ohmail/app-logic/press/delete-intents";
import { intentWindowsChannel } from "@ohmail/app-logic/press/intent-windows";
import { readAfterVerb, writeAfterVerb } from "@ohmail/app-logic/press/after-verb";
import { readingAlongKey } from "@ohmail/app-logic/reading/reading-along";
import { toldDevicesKey } from "@ohmail/app-logic/notices/use-notices";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import { CONSENT_BOOT_SCOPE } from "@ohmail/app-logic/consent/consent-state";
import { foldersOpenedKey, mailOriginalKey, searchSortKey, subjectDisplayKey } from "@ohmail/app-logic/storage/persisted-ui";
import { imageQualityKeyFor } from "@ohmail/app-logic/write/image-quality";
import { seedNotNowKey } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { pileNoteNotNowKey } from "@ohmail/app-logic/lists/pile-note";

type Scope = string | null;

/** The key the after-verb choice is written under: its builder is the write itself. */
function afterVerbKey(scope: Scope): string {
  window.localStorage.clear();
  writeAfterVerb("stay", scope);
  return Object.keys(window.localStorage).join(" ");
}

/** Every builder of a family a web view keeps, by the family it spells. */
const BUILDERS: Record<string, (scope: Scope) => string> = {
  compose: (s) => composeDraftKey(s),
  composeSession: (s) => composeSessionKey(s),
  composeRow: (s) => composeRowKey(s),
  reply: (s) => replyDraftKey("m-1", s),
  replyMeta: (s) => replyMetaKey("m-1", s),
  sendLocks: (s) => sendLocksKey(s),
  sentCopyNotes: (s) => sentCopyNotesKey(s),
  screenerIntents: (s) => screenerIntentsKey(s),
  impersonationSeen: (s) => impersonationSeenKey(s),
  deleteIntents: (s) => deleteIntentsKey(s),
  routingIntents: (s) => routingIntentsKey(s),
  undoWindows: (s) => intentWindowsChannel(s),
  readingAlong: (s) => readingAlongKey(s),
  toldDevices: (s) => toldDevicesKey(s),
  searchOrder: (s) => searchSortKey(s),
  foldersOpened: (s) => foldersOpenedKey(s),
  originalLook: (s) => mailOriginalKey(s),
  subjectDisplay: (s) => subjectDisplayKey(s),
  reviewPutOff: (s) => seedNotNowKey(s),
  afterVerb: afterVerbKey,
  pictureQuality: (s) => imageQualityKeyFor(s),
};

/** The families that exist only for an identified account. */
const KEPT_FOR_SOMEBODY: Record<string, (scope: string) => string> = {
  newsScreeningPutOff: (s) => pileNoteNotNowKey("news", s),
  receiptsScreeningPutOff: (s) => pileNoteNotNowKey("receipts", s),
  consentCache: (s) => bootCacheKey(CONSENT_BOOT_SCOPE, s),
  ownAddresses: (s) => bootCacheKey("own-addresses", s),
  unsubscribeSeen: unsubscribeSeenKey,
};

/** The hosts' own families: each named by the session's account or a page's, never by a view's scope. */
const HOSTS_OWN: Record<string, string> = {
  "ohmail.lifecycle.": "the web host marks an account's catch-up notice shown, under the session's account",
  "ohmail.access.": "the web host's wall keeps whether this device last found the session's account open",
  "ohmail.revoke.owed.": "the resume page keeps a wipe it still owes after a revoke",
  "ohmail.resume-attempted.": "the resume page marks that this tab tried to resume the session's account",
  "ohmail.session.scopeCleanup.": "the sign-out keeps the cleanup it still owes, named by the signed-out session's account or an isolated scope (apps/webapp/app/pending-sign-out-storage.ts)",
  "ohmail.session.lateWatch.": "the session client watches for a late renewal answer, per session",
  "ohmail.oauth.owner.": "a provider's sign-in remembers which session's account started it",
  "ohmail.notifications.subscription": "the push registration names the session's account it was made for",
};

const BROWSER: readonly string[] = ["localStorage", "sessionStorage", "indexedDB", "cache", "channel", "cookie"];
const families = STORED_KEYS.filter(
  (row) => "family" in row && row.family === true && row.owner === "web" && BROWSER.includes(row.store),
);

afterEach(() => window.localStorage.clear());

describe("every family the web keeps in a browser's storage takes the scope its mount hands in", () => {
  it("is built in the table for an account and for none, or is a host's own with its reason", () => {
    expect(families.length, "the registry names no family the web keeps: the census reads nothing").toBeGreaterThan(0);
    const keys = [
      ...Object.values(BUILDERS).flatMap((build) => [build("acc-1"), build(null)]),
      ...Object.values(KEPT_FOR_SOMEBODY).map((build) => build("acc-1")),
    ];
    expect(families.filter((row) => !(row.key in HOSTS_OWN) && !keys.some((k) => k.startsWith(row.key))).map((row) => row.key))
      .toEqual([]);
    expect(Object.keys(HOSTS_OWN).filter((key) => !families.some((row) => row.key === key)), "a host's family the registry no longer names")
      .toEqual([]);
  });

  it("names the account for a scope, and nobody's words for none", () => {
    for (const [family, build] of Object.entries(BUILDERS)) {
      expect(build("acc-1"), family).toContain("acc-1");
      expect(build(null), family).not.toContain("acc-1");
    }
    for (const [family, build] of Object.entries(KEPT_FOR_SOMEBODY)) {
      expect(build("acc-1"), family).toContain("acc-1");
      expect(() => build(null as unknown as string), `${family}: kept under no scope`).toThrow(/no owner/);
    }
  });

  it("refuses a scope nobody handed in, and an empty one, before it names anything", () => {
    for (const missing of [undefined, ""] as unknown as Scope[]) {
      const read = Object.entries(BUILDERS).filter(([, build]) => {
        try {
          build(missing);
          return true;
        } catch {
          return false;
        }
      }).map(([family]) => family);
      /* The routing journal's key is the engine's: the routing window pins the scope it hands it (`usePinnedScope`),
         which refuses a missing one before any key is named. */
      expect(read, String(missing)).toEqual(["routingIntents"]);
    }
    expect(() => readAfterVerb(undefined as unknown as Scope)).toThrow(/storage scope/);
    for (const [family, build] of Object.entries(KEPT_FOR_SOMEBODY)) {
      for (const missing of [undefined, ""] as unknown as string[]) expect(() => build(missing), `${family}: ${String(missing)}`).toThrow(/no owner/);
    }
  });
});
