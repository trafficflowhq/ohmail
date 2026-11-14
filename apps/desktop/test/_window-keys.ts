import { expect } from "vitest";
import { routingIntentsKey } from "@ohmail/client-engine";

import { imageQualityKeyFor } from "../../webapp/app/components/image-quality";
import { AFTER_VERB_STORAGE_KEY } from "@ohmail/app-logic/press/after-verb";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import {
  COMPOSE_DRAFT_PREFIX, LEGACY_COMPOSE_DRAFT_KEY, composeDraftKey, composeRowKey, composeSessionKey,
} from "../../webapp/app/shell/compose";
import { deleteIntentsKey } from "@ohmail/app-logic/press/delete-intents";
import { replyDraftKey, replyMetaKey, sentCopyNotesKey } from "../../webapp/app/shell/mail-send";
import { RETIRED_ID_SETS, foldersOpenedKey, mailOriginalKey, searchSortKey } from "@ohmail/app-logic/storage/persisted-ui";
import { readingAlongKey } from "@ohmail/app-logic/reading/reading-along";
import { screenerIntentsKey } from "../../webapp/app/shell/screener-intents";
import { seedNotNowKey } from "../../webapp/app/shell/seed-offer";
import { sendLocksKey } from "../../webapp/app/shell/send-lock";
import { ACCESS_VERDICT_PREFIX } from "@ohmail/app-logic/doors/wall-lift";
import { windowSentFoldersKey } from "../src/window-outbox-store.js";

export interface WindowKeys { gone: string[]; kept: string[] }

/** A mailbox's preferences; the impersonation mark is the Screener's (#777), by name until its builder is on main. */
const preferences = (scope: string): string[] => [
  searchSortKey(scope), seedNotNowKey(scope), `${AFTER_VERB_STORAGE_KEY}:${scope}`, imageQualityKeyFor(scope),
  `ohmail.screener.impersonationSeen.${scope}`, foldersOpenedKey(scope), mailOriginalKey(scope),
];
/** A note this tab keeps about a mailbox, in `sessionStorage` (the catch-up note's builder is private). */
const NOTE = "ohmail.lifecycle.";
const note = (scope: string): string => `${NOTE}${scope}.caughtUp`;
const held = (k: string): boolean => localStorage.getItem(k) !== null || sessionStorage.getItem(k) !== null;

/**
 * THE WINDOW'S KEYS, seeded with the shell's own builders — once the shell is up, since it replays its
 * journals at mount. `gone`: mbx-1's, its letters' Sent copy notes, its reply buffers, and the reply buffers
 * that name no mailbox, which an end of that account sweeps. `kept`: another mailbox's (mbx-10, and mbx-1.x, a
 * dotted id whose keys begin like mbx-1's), their send lanes, Sent copy notes, reply buffers and preferences, the
 * device's own, and mbx-1's send lane, preferences and tab note, which Sign out and a revoke keep for the
 * account's next sign-in. An erasure (`"erased"`) takes those of mbx-1 too: the engine discarded its outbox with
 * the account, and nothing of it may stay. Nor may the id sets an earlier build kept device-wide, whose values
 * carried mbx-1's folder paths and message ids.
 */
export function seedWindowKeys(end?: "erased"): WindowKeys {
  const own = [sendLocksKey("mbx-1"), ...preferences("mbx-1"), note("mbx-1"), ...(end === "erased" ? RETIRED_ID_SETS : [])];
  const gone = [
    screenerIntentsKey("mbx-1"), deleteIntentsKey("mbx-1"), routingIntentsKey("mbx-1"),
    composeDraftKey("mbx-1"), composeSessionKey("mbx-1"), composeRowKey("mbx-1"), `${COMPOSE_DRAFT_PREFIX}mbx-1`,
    readingAlongKey("mbx-1"), `${ACCESS_VERDICT_PREFIX}mbx-1`, bootCacheKey("consent", "mbx-1"), windowSentFoldersKey("mbx-1"),
    replyDraftKey("msg-1", "mbx-1"), replyMetaKey("lane-1", "mbx-1"), replyDraftKey("msg-1", null), replyMetaKey("lane-1", null),
    LEGACY_COMPOSE_DRAFT_KEY, sentCopyNotesKey("mbx-1"), ...(end === "erased" ? own : []),
  ];
  const kept = [
    screenerIntentsKey("mbx-10"), composeDraftKey("mbx-10"), composeDraftKey("mbx-1.x"), `${ACCESS_VERDICT_PREFIX}mbx-10`,
    bootCacheKey("consent", "mbx-10"), sendLocksKey("mbx-10"), sendLocksKey("mbx-1.x"), ...(end === "erased" ? [] : own),
    sentCopyNotesKey("mbx-10"), sentCopyNotesKey("mbx-1.x"),
    replyDraftKey("msg-1", "mbx-10"), replyMetaKey("lane-1", "mbx-1.x"), "ohmail.theme", "ohmail.layout",
    ...preferences("mbx-10"), ...preferences("mbx-1.x"), note("mbx-10"),
    windowSentFoldersKey("mbx-10"), windowSentFoldersKey("mbx-1.x"),
  ];
  for (const k of [...gone, ...kept]) (k.startsWith(NOTE) ? sessionStorage : localStorage).setItem(k, "[]");
  expectKept({ gone, kept }, "seeded");
  return { gone, kept };
}

/** The end swept mbx-1's keys and the reply buffers that name no mailbox, and nothing else. */
export function expectSwept(keys: WindowKeys, where: string): void {
  expect(keys.gone.filter(held), `${where}: left behind`).toEqual([]);
  expect(keys.kept.filter((k) => !held(k)), `${where}: swept with it`).toEqual([]);
}

/** Nothing was swept. */
export function expectKept(keys: WindowKeys, where: string): void {
  expect([...keys.gone, ...keys.kept].filter((k) => !held(k)), `${where}: swept`).toEqual([]);
}
