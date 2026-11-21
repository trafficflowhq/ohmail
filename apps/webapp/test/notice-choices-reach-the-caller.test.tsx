/** @vitest-environment jsdom */
/**
 * A SWITCH PRESSED REACHES THE NOTICES' CALLER AT ONCE. The caller reads this device's choices at each settle of the
 * copy; with no mail moving there is no settle, so a surface that rings alerts by itself would keep ringing a set the
 * person just switched off. The version the shell hands the caller moves whenever the choices are written: by the
 * pane's press here, and by another tab's write of either record.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryMirrorStore, aheadAlert, aheadSet, type AheadSet, type NoticeAhead } from "@ohmail/client-engine";
import { toldDevicesIn, useNotices, type HostNoticeEmitter, type NoticeReads } from "@ohmail/app-logic/notices/use-notices";
import { writeCalendarNotice } from "@ohmail/app-logic/notices/browser-channels";
import {
  CALENDAR_NOTICES_KEY,
  NOTIFICATION_CHANNELS_KEY,
  readCalendarNotices,
  readChannels,
  storedNoticeChoices,
  useNoticesVersion,
  writeChannels,
} from "../app/shell/notification-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = "acct-a";
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(`${CALENDAR_NOTICES_KEY}.${SCOPE}`, JSON.stringify({ cal_alert: true }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  localStorage.clear();
});

/** One alert an hour from now, and a surface that takes whole sets, as the desktop's shell does. */
async function mounted() {
  const alert: NoticeAhead = aheadAlert(
    { id: "standup", title: "Standup", private: false, heldBack: false },
    true,
    { startMs: Date.now() + 3_600_000, allDay: false, leadMin: 10, acts: [] },
  )!;
  const sets: AheadSet[] = [];
  const emitter: HostNoticeEmitter = {
    carries: ["cal_alert"], acts: [], post: () => {}, takeBack: () => {},
    ahead: (set) => { sets.push(set); },
  };
  const reads: NoticeReads = {
    // The shell's own reading: the one reader of the two stored records.
    choices: () => storedNoticeChoices(SCOPE),
    permission: () => "granted",
    devices: () => null,
    atDevices: () => null,
    told: toldDevicesIn(),
    calendar: { liveScope: () => SCOPE, changes: () => null, ahead: (scope, nowMs) => aheadSet(scope, [alert], nowMs), clock: () => null },
  };
  const store = new MemoryMirrorStore();
  await store.load();
  function Shell() {
    useNotices({ reader: store, version: useNoticesVersion(0), settled: true, scope: SCOPE, emitter, reads });
    return null;
  }
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(createElement(Shell)));
  return { sets, alert };
}

const stored = (key: string, value: unknown) => {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new StorageEvent("storage", { key }));
};

describe("a switch pressed with no mail moving", () => {
  it("the master pressed off in the pane: the surface is handed the account's empty set at once", async () => {
    const { sets, alert } = await mounted();
    expect(sets).toEqual([{ scope: SCOPE, alerts: [alert] }]);
    await act(async () => writeChannels({ ...readChannels(SCOPE), master: false }, SCOPE));
    expect(sets.at(-1), "a switch pressed off left the set the surface holds").toEqual({ scope: SCOPE, alerts: [] });
  });

  it("another tab's write of either record reaches it too, and a write of any other key does not", async () => {
    const { sets, alert } = await mounted();
    await act(async () => stored(`${CALENDAR_NOTICES_KEY}.${SCOPE}`, { cal_alert: false }));
    expect(sets.at(-1)).toEqual({ scope: SCOPE, alerts: [] });
    await act(async () => stored(`${CALENDAR_NOTICES_KEY}.${SCOPE}`, { cal_alert: true }));
    expect(sets.at(-1)).toEqual({ scope: SCOPE, alerts: [alert] });
    await act(async () => stored(`${NOTIFICATION_CHANNELS_KEY}.${SCOPE}`, { ...readChannels(SCOPE), master: false }));
    expect(sets.at(-1)).toEqual({ scope: SCOPE, alerts: [] });
    const handed = sets.length;
    await act(async () => stored("ohmail.theme", "dark"));
    expect(sets, "a key that is no choice settled the caller").toHaveLength(handed);
  });
});

it("keeps each account's choices when switching away and back", () => {
  const other = "acct-b";
  writeChannels({ ...readChannels(SCOPE), master: false }, SCOPE);
  writeCalendarNotice("cal_alert", false, SCOPE);
  writeCalendarNotice("cal_alert", true, other);

  expect(readChannels(other).master).toBe(true);
  expect(readCalendarNotices(other)).toMatchObject({ cal_alert: true });
  expect(readChannels(SCOPE).master).toBe(false);
  expect(readCalendarNotices(SCOPE)).toMatchObject({ cal_alert: false });
});

it("does not assign an unowned install preference to the first account that reads it", () => {
  localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify({ master: false }));
  localStorage.setItem(CALENDAR_NOTICES_KEY, JSON.stringify({ cal_alert: true }));
  expect(readChannels(SCOPE).master).toBe(true);
  expect(readCalendarNotices("acct-b")).toBeNull();
});
