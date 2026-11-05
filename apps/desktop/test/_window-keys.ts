import { expect } from "vitest";
import { routingIntentsKey } from "@ohmail/client-engine";

import { bootCacheKey } from "../../webapp/app/shell/boot-cache";
import {
  COMPOSE_DRAFT_PREFIX, LEGACY_COMPOSE_DRAFT_KEY, composeDraftKey, composeRowKey, composeSessionKey,
} from "../../webapp/app/shell/compose";
import { deleteIntentsKey } from "../../webapp/app/shell/delete-intents";
import { replyDraftKey, replyMetaKey } from "../../webapp/app/shell/mail-send";
import { searchSortKey } from "../../webapp/app/shell/persisted-ui";
import { readingAlongKey } from "../../webapp/app/shell/reading-along";
import { screenerIntentsKey } from "../../webapp/app/shell/screener-intents";
import { sendLocksKey } from "../../webapp/app/shell/send-lock";
import { ACCESS_VERDICT_PREFIX } from "../../webapp/app/shell/wall-lift";
import { windowSentFoldersKey } from "../src/window-outbox-store.js";

export interface WindowKeys { gone: string[]; kept: string[] }

/**
 * THE WINDOW'S KEYS, seeded with the shell's own builders — once the shell is up, since it replays its
 * journals at mount. `gone`: mbx-1's and the reply buffers, which an end of that account sweeps. `kept`:
 * another mailbox's (mbx-10, and mbx-1.x, a dotted id whose keys begin like mbx-1's), their send lanes, the
 * preferences, and mbx-1's send lane, which Sign out and a revoke keep for the account's next sign-in. An
 * erasure (`"erased"`) takes mbx-1's send lane too: the engine discarded its outbox with the account.
 */
export function seedWindowKeys(end?: "erased"): WindowKeys {
  const lane = sendLocksKey("mbx-1");
  const gone = [
    screenerIntentsKey("mbx-1"), deleteIntentsKey("mbx-1"), routingIntentsKey("mbx-1"),
    composeDraftKey("mbx-1"), composeSessionKey("mbx-1"), composeRowKey("mbx-1"), `${COMPOSE_DRAFT_PREFIX}mbx-1`,
    readingAlongKey("mbx-1"), `${ACCESS_VERDICT_PREFIX}mbx-1`, bootCacheKey("consent", "mbx-1"), windowSentFoldersKey("mbx-1"),
    replyDraftKey("msg-1"), replyMetaKey("lane-1"), LEGACY_COMPOSE_DRAFT_KEY, ...(end === "erased" ? [lane] : []),
  ];
  const kept = [
    screenerIntentsKey("mbx-10"), composeDraftKey("mbx-10"), composeDraftKey("mbx-1.x"), `${ACCESS_VERDICT_PREFIX}mbx-10`,
    bootCacheKey("consent", "mbx-10"), sendLocksKey("mbx-10"), sendLocksKey("mbx-1.x"), ...(end === "erased" ? [] : [lane]),
    "ohmail.theme", "ohmail.layout", searchSortKey("mbx-1"), "ohmail.ui.seed.notNow.mbx-1",
    windowSentFoldersKey("mbx-10"), windowSentFoldersKey("mbx-1.x"),
  ];
  for (const k of [...gone, ...kept]) localStorage.setItem(k, "[]");
  expectKept({ gone, kept }, "seeded");
  return { gone, kept };
}

/** The end swept mbx-1's keys and the reply buffers, and nothing else. */
export function expectSwept(keys: WindowKeys, where: string): void {
  expect(keys.gone.filter((k) => localStorage.getItem(k) !== null), `${where}: left behind`).toEqual([]);
  expect(keys.kept.filter((k) => localStorage.getItem(k) === null), `${where}: swept with it`).toEqual([]);
}

/** Nothing was swept. */
export function expectKept(keys: WindowKeys, where: string): void {
  expect([...keys.gone, ...keys.kept].filter((k) => localStorage.getItem(k) === null), `${where}: swept`).toEqual([]);
}
