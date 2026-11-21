/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import {
  CALENDAR_NOTICES_KEY,
  NOTIFICATION_CHANNELS_KEY,
} from "@ohmail/app-logic/notices/browser-channels";
import { forgetThisBrowser } from "../app/sign-out";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("sign-out clears the departing account's new notice choices and keeps the other account's", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const account = "fixture-account";
  const other = "another-account";
  const day = { cal_alert: true, showTitles: false };
  const summary = { cal_summary: true, summaryAt: 570, summaryDay: "2026-11-17", widgetTitles: false };
  for (const owner of [account, other]) {
    localStorage.setItem(`${CALENDAR_NOTICES_KEY}.${owner}`, JSON.stringify({ ...day, ...summary }));
    localStorage.setItem(`${NOTIFICATION_CHANNELS_KEY}.${owner}`, JSON.stringify({ master: false, showMailDetails: true }));
  }

  await forgetThisBrowser(account, { revokeWake: false });

  expect(localStorage.getItem(`${CALENDAR_NOTICES_KEY}.${account}`)).toBe(JSON.stringify(day));
  expect(localStorage.getItem(`${NOTIFICATION_CHANNELS_KEY}.${account}`)).toBe(JSON.stringify({ master: false }));
  expect(localStorage.getItem(`${CALENDAR_NOTICES_KEY}.${other}`)).toBe(JSON.stringify({ ...day, ...summary }));
  expect(localStorage.getItem(`${NOTIFICATION_CHANNELS_KEY}.${other}`)).toBe(JSON.stringify({ master: false, showMailDetails: true }));
});
