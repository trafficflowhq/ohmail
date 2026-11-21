/** @vitest-environment jsdom */
import { Frame } from "@ohmail/app/frame";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { fireEvent, render, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { AwayResponderSaveWire, AwayResponderWire } from "../app/api-client";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import de from "../messages/de.json";
import messages from "../messages/en.json";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

type Save = Omit<AwayResponderWire, "updatedAt">;
const A = messages.away;
const WAITING: AwayResponderSaveWire = {
  enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
};
const APPLIED = { ...WAITING, enabled: true, updatedAt: "2026-09-10T12:00:00.000Z" };
const FUTURE = "2036-09-14T23:59:59.000Z";
const PAST = "2020-01-02T23:59:59.000Z";
const POLL = 20_000;

beforeAll(warmCloudShell);
afterEach(async () => {
  await teardownConfirmEnv();
  window.history.replaceState(null, "", "/");
});

async function press(el: HTMLElement) {
  await act(async () => { fireEvent.click(el); });
  await tick(100);
}

async function mount({
  row = {}, lang = "en", hash = "#/settings/away", save, zone = "UTC",
}: {
  row?: Partial<AwayResponderSaveWire>;
  lang?: "en" | "de";
  hash?: string;
  zone?: string;
  save?: (next: Save) => AwayResponderSaveWire;
} = {}) {
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  let answer = { ...WAITING, ...row };
  let reads = 0;
  const writes: Save[] = [];
  const cloud = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), location.origin).pathname !== "/api/away-responder") return cloud(input, init);
    if (init?.method !== "PUT") {
      reads += 1;
      return Response.json(answer);
    }
    const next = JSON.parse(String(init.body)) as Save;
    writes.push(next);
    const echo = save?.(next) ?? { ...next, updatedAt: APPLIED.updatedAt };
    if (echo.pending !== true) answer = echo;
    return Response.json(echo, { status: echo.pending === true ? 202 : 200 });
  };
  window.history.replaceState(null, "", `/mailbox${hash}`);
  const host = await mountCloudShell((shell) => (
    <NextIntlClientProvider locale={lang} messages={lang === "de" ? de : messages} timeZone={zone}>{shell}</NextIntlClientProvider>
  ));
  await tick(2500);
  const ui = within(host);
  const words = lang === "de" ? de : messages;
  const pane = () => within(ui.getByRole("region", { name: words.settings.away }));
  return {
    ui, writes, reads: () => reads, answer: (next: AwayResponderSaveWire) => { answer = next; },
    text: () => ui.getByRole("region", { name: words.settings.away }).textContent,
    nav: () => within(ui.getByRole("navigation", { name: words.settings.navAria })),
    toggle: () => pane().getByRole("switch", { name: words.away.title }),
    field: () => pane().getByRole<HTMLTextAreaElement>("textbox", { name: words.away.bodyLabel }),
    date: () => pane().getByRole("button", { name: words.away.untilPick }),
    clear: () => pane().queryByRole("button", { name: words.away.untilClear }),
    save: () => press(pane().getAllByRole("button", { name: words.away.save }).at(-1)!),
    goOhbox: () => press(within(ui.getByRole("navigation", { name: "Places" })).getByRole("button", { name: /^Ohbox/ })),
  };
}

const travelled = (row: AwayResponderSaveWire = WAITING) => (): AwayResponderSaveWire => ({ ...row, pending: true });
const nextPoll = () => tick(POLL);

it("opens Away from its own Settings entry beside Screener and Rules", async () => {
  const s = await mount({ hash: "#/settings/general" });
  const nav = s.nav();
  const buttons = nav.getAllByRole("button");
  const screener = nav.getByRole("button", { name: messages.settings.screener });
  const away = nav.getByRole("button", { name: messages.settings.away });
  const rules = nav.getByRole("button", { name: messages.settings.rules });
  expect(buttons.indexOf(away)).toBeGreaterThan(buttons.indexOf(screener));
  expect(buttons.indexOf(away)).toBeLessThan(buttons.indexOf(rules));
  expect(s.ui.queryByRole("switch", { name: A.title })).toBeNull();
  await press(away);
  expect(window.location.hash).toBe("#/settings/away");
  expect(s.toggle()).toBeDefined();
  await press(screener);
  expect(s.ui.queryByRole("switch", { name: A.title })).toBeNull();
});

it.each([true, false])("only lists the Away pane when the host supplies it (%s)", async (away) => {
  installConfirmEnv();
  const { WEB_PANE_PARTS } = await import("../app/(product)/mailbox/pane-parts");
  const settings = mailSettings({
    ...NO_PANE_PARTS,
    general: () => <p>General controls</p>,
    ...(away ? { away: WEB_PANE_PARTS.away } : { screener: () => <p>Screener controls</p> }),
  });
  const { host } = fakeHost({
    engine: NO_ENGINE, service: away ? "managed" : "ownComputer", scope: "owner",
    address: fakeAddress("#/settings/general"), places: { settings },
    wires: away ? { away: { state: async () => WAITING, save: async () => WAITING } } : undefined,
  });
  const mounted = render(
    <TextProvider locale="en" messages={messages as Messages} timeZone="UTC">
      <Frame host={{ ...host, capabilities: { ...host.capabilities, awayRunsOn: away ? "service" : "none" } }} />
    </TextProvider>,
  );
  try {
    const menu = within(mounted.getByRole("navigation", { name: messages.settings.navAria }));
    const entry = menu.queryByRole("button", { name: messages.settings.away });
    if (away) {
      expect(entry).not.toBeNull();
      expect(menu.queryByRole("button", { name: messages.settings.screener })).toBeNull();
      await press(entry!);
      expect(mounted.getByRole("switch", { name: A.title })).toBeDefined();
    } else {
      expect(entry).toBeNull();
      expect(mounted.container.textContent).not.toContain(A.title);
    }
  } finally {
    mounted.unmount();
  }
});

it("rests on No end date without a clear action or an end-date sentence", async () => {
  const s = await mount({ row: { enabled: true } });
  expect(s.date().textContent).toBe(A.untilNone);
  expect(s.clear()).toBeNull();
  expect(s.text()).not.toContain("On until");
});

it("names a stored end date and says when the responder stops", async () => {
  const s = await mount({ row: { enabled: true, endsAt: FUTURE } });
  expect(s.date().textContent).toBe("Sep 14, 2036");
  expect(s.text()).toContain("On until Sep 14, 2036.");
});

it.each([true, false])("handles an expired date with the responder enabled=%s", async (enabled) => {
  const s = await mount({ row: { enabled, endsAt: PAST } });
  if (enabled) expect(s.text()).toContain("The end date passed on Jan 2, 2020.");
  expect(s.text()).not.toContain("On until");
  await s.save();
  expect(s.writes).toHaveLength(enabled ? 0 : 1);
  if (enabled) {
    expect(s.text()).toContain(A.untilExpired);
    expect(s.text()).not.toContain(A.saved);
  } else {
    expect(s.text()).toContain(A.saved);
  }
});

it("clears the chosen end date and stores null", async () => {
  const s = await mount({ row: { enabled: true, endsAt: FUTURE } });
  await press(s.clear()!);
  expect(s.date().textContent).toBe(A.untilNone);
  await s.save();
  expect(s.writes.map((w) => w.endsAt)).toEqual([null]);
});

it("chooses a day from the calendar, writes its last second, and reads back the same date", async () => {
  const s = await mount({ row: { enabled: true } });
  await press(s.date());
  const picker = within(s.ui.getByRole("dialog", { name: A.untilPick }));
  const today = picker.getByRole("gridcell", { name: /September 4, 2026/ });
  expect(today.getAttribute("aria-disabled")).toBe("true");
  const tomorrow = picker.getByRole("gridcell", { name: /September 5, 2026/ });
  expect(tomorrow.getAttribute("aria-disabled")).toBeNull();
  await press(tomorrow);
  expect(s.date().textContent).toBe("Sep 5, 2026");
  await s.save();
  expect(s.writes.map((w) => w.endsAt)).toEqual(["2026-09-05T23:59:59.000Z"]);
  expect(s.date().textContent).toBe("Sep 5, 2026");
});

it("uses the German nav, date field and saved end-date sentence", async () => {
  const s = await mount({ lang: "de", row: { enabled: true, endsAt: FUTURE } });
  expect(s.nav().getByRole("button", { name: de.settings.away })).toBeDefined();
  expect(s.text()).toContain(de.away.untilLabel);
  expect(s.text()).toContain("An bis 14.09.2036.");
});

it("shows the waiting sentence over the stored row, then takes the applied values", async () => {
  const s = await mount({ save: travelled() });
  await press(s.toggle());
  await s.save();
  expect(s.writes.map((w) => w.enabled)).toEqual([true]);
  expect(s.text()).toContain(A.asked);
  expect(s.text()).not.toContain(A.applied);
  expect(s.text()).not.toContain(A.saved);
  expect(s.toggle().getAttribute("aria-checked")).toBe("false");
  const before = s.reads();
  s.answer(APPLIED);
  await nextPoll();
  expect(s.reads() - before).toBe(1);
  expect(s.text()).not.toContain(A.asked);
  expect(s.text()).toContain(A.applied);
  expect(s.text()).not.toContain(A.changedElsewhere);
  expect(s.toggle().getAttribute("aria-checked")).toBe("true");
  expect(s.text()).not.toContain(A.unsavedStillOn);
  await s.goOhbox();
  expect(location.hash).toBe("#/ohbox");
});

it("waits while the row stays the same and stops reading at the watcher's limit", async () => {
  const s = await mount({ save: travelled() });
  await s.save();
  const before = s.reads();
  await tick(POLL * 12);
  expect(s.reads() - before).toBe(12);
  expect(s.text()).toContain(A.asked);
  expect(s.text()).not.toContain(A.applied);
  const spent = s.reads();
  await tick(POLL * 12);
  expect(s.reads()).toBe(spent);
});

it("shows another install's changed values and says the request did not apply", async () => {
  const s = await mount({ save: travelled() });
  await s.save();
  expect(s.text()).toContain(A.asked);
  s.answer({ ...WAITING, body: "On sabbatical", updatedAt: APPLIED.updatedAt });
  await nextPoll();
  expect(s.text()).not.toContain(A.applied);
  expect(s.text()).not.toContain(A.asked);
  expect(s.text()).toContain(A.changedElsewhere);
  expect(s.field().value).toBe("On sabbatical");
});

it("recognizes the same request when the stored instant and pile order are respelled", async () => {
  const row: AwayResponderSaveWire = {
    ...WAITING, enabled: true, startsAt: "2026-09-14T00:00:00+02:00", piles: ["ohmail/News", "INBOX"],
  };
  const s = await mount({ row, save: travelled(row) });
  await s.save();
  s.answer({ ...row, startsAt: "2026-09-13T22:00:00.000Z", piles: ["INBOX", "ohmail/News"], updatedAt: APPLIED.updatedAt });
  await nextPoll();
  expect(s.text()).toContain(A.applied);
  expect(s.text()).not.toContain(A.changedElsewhere);
});

it("polls once for the later request and never reports the earlier one as applied", async () => {
  const s = await mount({ save: travelled() });
  await press(s.toggle());
  await s.save();
  await s.save();
  expect(s.writes.map((w) => w.enabled)).toEqual([true, false]);
  expect(s.text()).toContain(A.asked);
  const before = s.reads();
  s.answer(APPLIED);
  await nextPoll();
  expect(s.reads() - before).toBe(1);
  expect(s.text()).not.toContain(A.applied);
  expect(s.text()).toContain(A.changedElsewhere);
});

it("keeps words typed during the wait and asks before leaving with them", async () => {
  const s = await mount({ save: travelled() });
  await press(s.toggle());
  await s.save();
  await act(async () => { fireEvent.change(s.field(), { target: { value: "Back Tuesday" } }); });
  s.answer(APPLIED);
  await nextPoll();
  expect(s.text()).toContain(A.applied);
  expect(s.field().value).toBe("Back Tuesday");
  expect(s.text()).toContain(A.unsavedStillOn);
  await s.goOhbox();
  expect(s.text()).toContain(A.leaveAsk);
  expect(location.hash).toBe("#/settings/away");
});

it("reports an ordinary save and never starts a watcher", async () => {
  const s = await mount();
  await s.save();
  expect(s.text()).toContain(A.saved);
  expect(s.text()).not.toContain(A.asked);
  const before = s.reads();
  await tick(POLL * 13);
  expect(s.reads()).toBe(before);
});

it("uses the frame's non-UTC day for the picker, stored instant and saved date", async () => {
  const s = await mount({
    zone: "America/Los_Angeles", row: { enabled: true, endsAt: "2036-09-15T04:00:00.000Z" },
  });
  expect(s.date().textContent).toBe("Sep 14, 2036");
  expect(s.text()).toContain("On until Sep 14, 2036.");
  await press(s.date());
  const picker = within(s.ui.getByRole("dialog", { name: A.untilPick }));
  await press(picker.getByRole("gridcell", { name: /September 15, 2036/ }));
  await s.save();
  expect(s.writes.map((w) => w.endsAt)).toEqual(["2036-09-16T06:59:59.000Z"]);
  expect(s.date().textContent).toBe("Sep 15, 2036");
  expect(s.text()).toContain("On until Sep 15, 2036.");
});
