/** @vitest-environment jsdom */
/**
 * SETTINGS SHOWS THE LIVE ACCOUNT'S WAITING FILINGS, rendered. The phone's own engine outlives a
 * switch to another account; Settings read it unscoped, so under a Cloud or paired account the
 * "This phone" panel drew the phone's own mailbox, and the filings block it carried looked for that
 * mailbox among the other account's rows and drew nothing — the Ohbox strip sent people to a page
 * with no Try again and no Leave.
 */
import { createElement as h, type ReactNode } from "react";
import { act, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, styleOf } from "./_rendered-dom";
import { MANAGED_ORIGIN, type ConnectedSession } from "../src/net/pairing";
import type { PhoneMailbox } from "../src/net/mailboxes";
import { readAccess, resetAccessFeedForTests } from "../src/net/account";

const scene = vi.hoisted(() => ({
  world: null as unknown,
  session: null as unknown,
  opened: [] as string[],
  settingsPane: null as string | null,
  mailbox: null as string | null,
  returnTo: undefined as "settings" | "mailboxes" | undefined,
  pinnedLook: null as "paper" | "ohmarchy" | null,
  localeControls: null as import("../src/i18n/LocaleProvider").LocaleControls | null,
  setTheme: vi.fn(),
  pinLook: vi.fn(),
}));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Linking: { openURL: async (url: string) => { scene.opened.push(url); } },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-router", () => ({
  router: {
    push: (route: { params?: { pane?: string; mailbox?: string; returnTo?: "settings" | "mailboxes" } }) => {
      scene.settingsPane = route.params?.pane ?? null;
      scene.mailbox = route.params?.mailbox ?? null;
      scene.returnTo = route.params?.returnTo;
    },
    replace: () => { scene.settingsPane = null; scene.mailbox = null; },
    dismissTo: () => { scene.settingsPane = "mailboxes"; scene.mailbox = null; },
  },
  useLocalSearchParams: () => ({ pane: scene.settingsPane ?? undefined, mailbox: scene.mailbox ?? undefined, returnTo: scene.returnTo }),
  useFocusEffect: (effect: () => (() => void) | void) => useEffect(effect, [effect]),
}));
vi.mock("../src/theme", async () => {
  const { accountGovernsFace, accountWideOffered } = await import("../src/theme/face");
  return { accountGovernsFace, accountWideOffered, useTheme: () => ({
    mail: true, face: "paper", scheme: "light", type: { h1: { fontSize: 30 }, sectionLabel: { fontSize: 18 } },
    c: { ink: "ink", ink2: "ink2", accent: "accent", tint2: "tint2" }, radius: { pill: 999 },
  }) };
});
vi.mock("../src/state/store", () => ({
  usePrefs: () => ({ themePref: "system", setTheme: scene.setTheme, facePin: scene.pinnedLook, setFacePin: () => undefined, pinLook: scene.pinLook,
    pictureQuality: "medium", setPictureQuality: () => undefined }),
}));
vi.mock("../src/state/world", () => ({ useWorld: () => scene.world }));
vi.mock("../src/state/wake", () => ({ useWake: () => ({ state: { k: "off" }, choices: [], chosen: null, busy: false }) }));
vi.mock("../src/ui/wake-sentence", () => ({ wakeSentence: () => "" }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ state: { k: "live", session: scene.session } }) }));
vi.mock("../src/ui/base", async () => {
  const div = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Button: (p: { label: string; disabled?: boolean; onPress?: () => void }) =>
      h("button", { "data-button": p.label, disabled: p.disabled, onClick: p.onPress }, p.label),
    Txt: (p: { children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string }) =>
      h("span", { "data-role": p.accessibilityRole, "data-label": p.accessibilityLabel }, p.children),
    ViewHead: (p: { title: string; leading?: ReactNode }) => h("h1", null, p.leading, p.title),
    Chip: div, Panel: div, Rule: () => null, Screen: div, Scroller: div, Section: div,
    TapRow: (p: { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void }) =>
      h("button", { "aria-label": p.accessibilityLabel, onClick: p.onPress }, p.children),
    Tap: (p: { children?: ReactNode; accessibilityLabel?: string; accessibilityHint?: string; accessibilityState?: { selected?: boolean }; onPress?: () => void }) =>
      h("button", { "aria-label": p.accessibilityLabel, "data-hint": p.accessibilityHint,
        "aria-pressed": p.accessibilityState?.selected, onClick: p.onPress }, p.children),
  };
});
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/MoreNav", () => ({
  Nav: (p: { label: string; sub?: string; onPress: () => void }) => h("button", { "data-nav": p.label, onClick: p.onPress }, p.label, p.sub),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: (p: { name: string }) => h("i", { "data-icon": p.name }) }));
vi.mock("../src/ui/Field", () => ({ Field: () => null }));
vi.mock("../src/engine/backup-exclusion", () => ({ backupExclusion: () => null, subscribeBackupExclusion: () => () => undefined }));
vi.mock("../src/engine/engine-artifact", () => ({ phoneEngineStart: () => () => undefined }));
vi.mock("../src/engine/notification-permission-native", () => ({ openNotificationSettings: async () => undefined }));
vi.mock("../src/ui/NotifyPermission", () => ({ NotifyPermission: () => null }));
vi.mock("../src/ui/useNotifyPermission", () => ({ useNotifyPermission: () => ({ gate: async () => undefined }) }));
vi.mock("../src/i18n/LocaleProvider", async () => ({
  useLocale: (await import("../src/i18n/locale")).activeLocale,
  useLocaleControls: () => scene.localeControls,
}));
vi.mock("../src/ui/chrome", () => ({
  DetailBar: (p: { backLabel?: string; back?: () => void }) => h("button", { "data-back": p.backLabel, onClick: p.back }),
  PaneTop: () => null,
}));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => h("button", { "aria-label": "ohcal" }) }));
vi.mock("../src/ui/MailPlaceDock", () => ({
  MailPlaceDock: (p: { children: ReactNode }) => h("div", { "data-dock": "" }, p.children),
}));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/posture", () => ({
  usePosture: () => ({ sizeClass: "compact", heightClass: "full", panes: 1, split: "full", fold: "none", hinge: null }),
}));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/more-move", () => ({ YieldToMore: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/Segmented", () => ({
  Segmented: (p: { segments: { value: string; label: string; hint?: string }[]; value: string; fill?: boolean;
    accessibilityLabel?: string; accessibilityHint?: string; onChange(value: string): void }) =>
    h("div", { "data-segments": "", "data-fill": p.fill, "aria-label": p.accessibilityLabel, "data-hint": p.accessibilityHint },
      p.segments.map((segment) => h("button", {
        key: segment.value, "aria-pressed": segment.value === p.value, "data-hint": segment.hint,
        onClick: () => p.onChange(segment.value),
      }, segment.label))),
}));
vi.mock("../src/ui/AutoActPanel", () => ({ AutoActPanel: () => null, readsOnly: () => false }));
vi.mock("../src/ui/SettingsLookPreview", () => ({ SettingsLookPreview: (p: { face: string }) => h("div", { "data-face-preview": p.face }) }));
vi.mock("../src/ui/SignaturesPanel", () => ({ SignaturesPanel: () => null }));
vi.mock("../src/ui/AutoFiledPanel", () => ({ AutoFiledPanel: () => null }));
vi.mock("../src/ui/ProfileImportCard", () => ({ SavedSettingsPanel: () => null }));
vi.mock("../src/ui/WaitingStrip", () => ({ WaitingStrip: () => null }));
// The seed offer (#226) reaches the keystore, expo-secure-store and expo-modules-core (`__DEV__`).
vi.mock("../src/ui/SeedOfferCard", () => ({ SeedReopenPanel: () => null }));
vi.mock("../src/compose/attach", () => ({ IMAGE_QUALITY_LEVELS: [] }));
vi.mock("../src/engine/diagnostics", () => ({ writePhoneDiagnostics: async () => null }));
vi.mock("../src/engine/diagnostics-native", () => ({ nativePhoneDiagnosticDeps: () => ({}), shareDiagnosticFile: async () => true }));

import SettingsScreen from "../app/settings";
import { Copy } from "../src/copy";
import { setActiveLocale } from "../src/i18n/locale";
import { forgetOrganizerSessionForTests, holdStandaloneDoor, sayNotificationsOff, sayNotificationsOn } from "../src/engine/organizer-session";
import type { StandaloneEngine } from "../src/engine/standalone-door";

/** The phone's own engine, still running after the switch: it serves `own@phone.test`, id `m-own`. */
function ownEngine(): StandaloneEngine {
  return {
    accountId: "engine-account", address: "own@phone.test",
    get sessionToken() { return "launch"; },
    async handle() { return new Response("{}", { status: 404 }); },
    async stop() {}, log() {}, leave() {},
    async handBack() { return []; }, async forgetStoredLogin() { return true; }, async serverSettings() { return null; },
    async resume() { return []; }, async claimHere() { return "claimed" as const; }, async heldElsewhere() { return null; },
    async stopOrganizing() { return "stopped" as const; },
    runtimes: () => ({
      organizer: { "m-own": { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null, claimed: true } },
      connection: { "m-own": { reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished" } },
    }),
  } as unknown as StandaloneEngine;
}

const cloudBox: PhoneMailbox = {
  id: "m-cloud", address: "cloud@example.test", organizerRole: "organizer", organizeConsentedAt: null, organizedBy: null,
  organizedByThisInstall: true, organizerState: null, status: "connected", junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null,
  lastSyncAt: "2026-10-24T09:00:00.000Z",
  firstSyncStopFolder: null,
  filing: { due: 6, deferred: 6, stuck: 6, stuckSince: "2026-10-24T09:00:00.000Z", stuckRefusalClass: "no_such_folder",
    lastRefusalClass: "no_such_folder", nextAttemptAt: "2026-10-24T15:00:00.000Z", asOf: null },
};

function cloudAccount(rows: PhoneMailbox[]) {
  scene.settingsPane = null;
  scene.mailbox = null;
  scene.returnTo = undefined;
  const asked: { method: string; url: string; body?: string }[] = [];
  scene.session = {
    standalone: false,
    profile: { id: "fixture-profile", origin: "https://cloud.example", apiBase: null },
    async fetch(url: string, init: RequestInit = {}) {
      asked.push({ method: init.method ?? "GET", url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/filings/retry")) return Response.json({ reset: 6 });
      if (url.endsWith("/mailboxes/m-cloud/filings")) {
        return Response.json({ mailboxId: "m-cloud", groups: [{
          folder: "ohmail/Screened", count: 6, deletes: 0, since: "2026-10-24T09:00:00.000Z", through: "2026-10-24T09:05:00.000Z",
          nextAttemptAt: null, at: "INBOX", reasons: [{ reason: "no_such_folder", count: 6 }],
        }] });
      }
      return new Response("{}", { status: 404 });
    },
  };
  scene.world = {
    standalone: false,
    account: { name: "Cloud", email: "" },
    boot: { settled: false, connection: null, firstSync: null, setAside: null },
    face: { account: null, known: false, pending: false, applyAll: () => undefined },
    folders: { storable: false },
    autoAct: null,
    mailboxes: { known: true, rows },
    screener: { waiting: [], screened: [], spam: [], waitingPending: true },
  };
  return asked;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function openSection(view: ReturnType<typeof mount>, title: string) {
  const entry = menuEntry(view.el, title);
  expect(entry, title).toBeDefined();
  act(() => entry!.click());
  view.render(h(SettingsScreen));
}

function menuEntry(root: ParentNode, title: string) {
  return Array.from(root.querySelectorAll("button")).find((button) =>
    (button.getAttribute("aria-label") ?? button.getAttribute("data-nav") ?? button.textContent) === title,
  );
}

afterEach(() => {
  forgetOrganizerSessionForTests();
  resetAccessFeedForTests();
  document.body.innerHTML = "";
  scene.opened.length = 0;
  scene.settingsPane = null;
  scene.mailbox = null;
  scene.returnTo = undefined;
  scene.pinnedLook = null;
  scene.localeControls = null;
  scene.setTheme.mockClear();
  scene.pinLook.mockReset();
});

it.each([
  { locale: "en", themes: ["Light", "Auto", "Dark"], messages: "Messages" },
  { locale: "de", themes: ["Hell", "Automatisch", "Dunkel"], messages: "Nachrichten" },
] as const)("opens compact General controls and writes the picked theme and language in $locale", async ({ locale, themes, messages }) => {
  cloudAccount([]);
  const setLocale = vi.fn(async () => undefined);
  scene.localeControls = { locale, locales: ["en", "de"], chosen: null, setLocale, busy: false };
  setActiveLocale(locale);
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsGeneral);
    expect(view.el.querySelector("[data-back]")?.getAttribute("data-back")).toBe(Copy.settings);
    expect(view.el.textContent).not.toContain(Copy.languageNote);
    const [language, theme] = view.el.querySelectorAll("[data-segments]");
    expect(language?.getAttribute("data-fill")).toBe("false");
    expect([...language!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["English", "Deutsch"]);
    expect(language?.querySelector('[aria-pressed="true"]')?.textContent).toBe(locale === "en" ? "English" : "Deutsch");
    expect([...theme!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(themes);
    expect(view.el.textContent).toContain(messages);
    expect(view.el.textContent).toContain(Copy.pictureQuality);
    await act(async () => { (language!.querySelector('[aria-pressed="false"]') as HTMLElement).click(); });
    expect(setLocale).toHaveBeenCalledWith(locale === "en" ? "de" : "en");
    act(() => theme!.querySelectorAll("button")[2]!.click());
    expect(scene.setTheme).toHaveBeenCalledWith("dark");
  } finally {
    view.unmount();
    setActiveLocale("en");
  }
});

it("chooses the local look or sends it to the account from the General scope control", async () => {
  cloudAccount([]);
  const applyAll = vi.fn(async () => true);
  Object.assign(scene.world as object, { face: { account: "paper", known: true, pending: false, applyAll } });
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsGeneral);
    const local = [...view.el.querySelectorAll("button")].find((button) => button.textContent === "This device");
    const all = [...view.el.querySelectorAll("button")].find((button) => button.textContent === "All devices");
    expect(local).toBeDefined();
    expect(all?.getAttribute("aria-pressed")).toBe("true");
    expect([...view.el.querySelectorAll("[data-face-preview]")].map((tile) => tile.getAttribute("data-face-preview")))
      .toEqual(["paper", "ohmarchy"]);
    await act(async () => { menuEntry(view.el, Copy.faceOhmarchy)!.click(); });
    expect(applyAll).toHaveBeenCalledWith("ohmarchy");
    scene.pinLook.mockImplementation((face: "paper" | "ohmarchy") => { scene.pinnedLook = face; });
    const selects = (label: string) => [...view.el.querySelectorAll("button")].find((button) => button.textContent === label);
    act(() => local!.click());
    expect(scene.pinLook).toHaveBeenCalledWith("paper");
    view.render(h(SettingsScreen));
    act(() => menuEntry(view.el, Copy.faceOhmarchy)!.click());
    expect(scene.pinLook).toHaveBeenLastCalledWith("ohmarchy");
    expect(applyAll).toHaveBeenCalledTimes(1);
    view.render(h(SettingsScreen));
    await act(async () => { selects("All devices")!.click(); });
    expect(applyAll).toHaveBeenCalledTimes(2);
    expect(applyAll).toHaveBeenLastCalledWith("ohmarchy");
  } finally {
    view.unmount();
  }
});

it("ignores a second Look press while an account selection is still saving", async () => {
  cloudAccount([]);
  let finish!: (confirmed: boolean) => void;
  const write = new Promise<boolean>((resolve) => { finish = resolve; });
  const applyAll = vi.fn(() => write);
  Object.assign(scene.world as object, { face: { account: "paper", known: true, pending: false, applyAll } });
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsGeneral);
    const tile = menuEntry(view.el, Copy.faceOhmarchy)!;
    act(() => { tile.click(); tile.click(); });
    expect(applyAll).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    expect(view.el.textContent).not.toContain(Copy.faceFailed);
  } finally {
    view.unmount();
  }
});

it("opens just the pressed mailbox from the paired roster and gives back a stale detail on account switch", () => {
  const other = { ...cloudBox, id: "m-another", address: "other@example.test" };
  cloudAccount([{ ...cloudBox, filing: undefined }, other]);
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsMailboxes);
    const first = menuEntry(view.el, cloudBox.address);
    expect(first).toBeDefined();
    expect(menuEntry(view.el, "other@example.test")).toBeDefined();
    act(() => first!.click());
    view.render(h(SettingsScreen));
    expect(view.el.querySelector("[data-back]")?.getAttribute("data-back")).toBe(Copy.settingsMailboxes);
    expect(view.el.textContent).toContain(Copy.phoneThisPhone);
    expect(view.el.textContent).toContain(cloudBox.address);
    expect(view.el.textContent).not.toContain("other@example.test");
    const selected = scene.mailbox;
    cloudAccount([other]);
    scene.mailbox = selected;
    view.render(h(SettingsScreen));
    expect(view.el.textContent).not.toContain(cloudBox.address);
    expect(menuEntry(view.el, "other@example.test")).toBeDefined();
    const back = view.el.querySelector<HTMLButtonElement>(`[data-back="${Copy.settings}"]`);
    expect(back).not.toBeNull();
    act(() => back!.click());
    view.render(h(SettingsScreen));
    expect(menuEntry(view.el, Copy.settingsGeneral)).toBeDefined();
  } finally {
    view.unmount();
  }
});

it("returns the user to the roster when the opened mailbox was removed", () => {
  const other = { ...cloudBox, id: "m-another", address: "other@example.test", filing: undefined };
  cloudAccount([{ ...cloudBox, filing: undefined }, other]);
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsMailboxes);
    act(() => menuEntry(view.el, cloudBox.address)!.click());
    view.render(h(SettingsScreen));
    (scene.world as { mailboxes: { rows: PhoneMailbox[] } }).mailboxes.rows = [other];
    view.render(h(SettingsScreen));
    expect(view.el.textContent).not.toContain(cloudBox.address);
    expect(menuEntry(view.el, "other@example.test")).toBeDefined();
    expect(view.el.querySelector(`[data-back="${Copy.settings}"]`)).not.toBeNull();
  } finally {
    view.unmount();
  }
});

it("does not reopen a replacement account's mailbox from the previous detail even if the id matches", () => {
  cloudAccount([{ ...cloudBox, filing: undefined }]);
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsMailboxes);
    act(() => menuEntry(view.el, cloudBox.address)!.click());
    view.render(h(SettingsScreen));
    cloudAccount([{ ...cloudBox, address: "replacement@example.test", filing: undefined }]);
    scene.mailbox = cloudBox.id;
    view.render(h(SettingsScreen));
    expect(menuEntry(view.el, "replacement@example.test")).toBeDefined();
    expect(view.el.textContent).not.toContain(Copy.phoneThisPhone);
  } finally {
    view.unmount();
  }
});

it("does not show the old account's loaded filing actions when the next roster reuses an id", async () => {
  cloudAccount([cloudBox]);
  Object.assign(scene.world as object, { worldKey: "first" });
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsMailboxes);
    await settle();
    expect(view.el.querySelector('[data-button="Try again now"]')).not.toBeNull();
    cloudAccount([{ ...cloudBox, address: "next@example.test" }]);
    Object.assign(scene.world as object, { worldKey: "next" });
    (scene.session as { fetch: () => Promise<Response> }).fetch = () => new Promise<Response>(() => {});
    scene.settingsPane = "mailboxes";
    view.render(h(SettingsScreen));
    expect(menuEntry(view.el, "next@example.test")).toBeDefined();
    expect(view.el.querySelector('[data-button="Try again now"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

it("opens the Settings menu from a pane linked directly", () => {
  cloudAccount([cloudBox]);
  scene.settingsPane = "mailboxes";
  const view = mount(h(SettingsScreen));
  try {
    const back = view.el.querySelector<HTMLButtonElement>(`[data-back="${Copy.settings}"]`);
    expect(back).not.toBeNull();
    act(() => back!.click());
    view.render(h(SettingsScreen));
    expect(menuEntry(view.el, Copy.settingsGeneral)).toBeDefined();
  } finally {
    view.unmount();
  }
});

it.each([
  { locale: "en", mail: "Mail", account: "Account", about: "About", devices: "Devices", servers: "Servers" },
  { locale: "de", mail: "Mail", account: "Account", about: "Über", devices: "Geräte", servers: "Server" },
] as const)("groups Settings and opens Devices in $locale", ({ locale, mail, account, about, devices, servers }) => {
  cloudAccount([]);
  setActiveLocale(locale);
  const view = mount(h(SettingsScreen));
  try {
    const groups = [...view.el.querySelectorAll('[data-testid="settings-group"]')];
    expect(groups.map((group) => group.getAttribute('data-label'))).toEqual([mail, account, about]);
    const heading = groups[0]?.querySelector('[data-role="header"]');
    expect(heading?.getAttribute("data-label")).toBe(mail);
    expect(heading?.textContent?.replace(/\u2060/g, "")).toBe(mail);
    expect(styleOf(heading?.querySelector("[data-ax-hidden]") ?? null).backgroundColor).toBe("ink");
    expect(menuEntry(groups[1]!, devices)).toBe(groups[1]?.querySelector('button'));
    openSection(view, devices);
    expect(view.el.querySelector(`[data-nav="${servers}"]`)).not.toBeNull();
    expect(view.el.querySelector('[data-testid="settings-group"]')).toBeNull();
  } finally {
    view.unmount();
    setActiveLocale("en");
  }
});

it("marks the mail heading when notification permission is refused and clears it when permission returns", () => {
  cloudAccount([]);
  const view = mount(h(SettingsScreen));
  try {
    const color = () => styleOf(view.el.querySelector('[data-role="header"][data-label="Mail"] [data-ax-hidden]')).backgroundColor;
    expect(color()).toBe("ink");
    act(() => sayNotificationsOff());
    expect(color()).toBe("accent");
    act(() => sayNotificationsOn());
    expect(color()).toBe("ink");
  } finally {
    view.unmount();
  }
});

it.each([
  { locale: "en", general: "oh · AutoEnglish", notifications: "Off", mailbox: "Connected", waiting: "2 waiting", screened: "1 screened out · 3 in Spam" },
  { locale: "de", general: "oh · AutomatischDeutsch", notifications: "Aus", mailbox: "Verbunden", waiting: "2 warten", screened: "1 aussortiert · 3 im Spam" },
] as const)("shows the settled mail facts on the Settings menu in $locale", (words) => {
  cloudAccount([{ ...cloudBox, displayName: "Fixture mailbox" }]);
  const world = scene.world as { boot: { settled: boolean }; screener: unknown };
  world.boot.settled = true;
  world.screener = { waiting: [{}, {}], screened: [{}], spam: [{}, {}, {}], waitingPending: false };
  setActiveLocale(words.locale);
  const view = mount(h(SettingsScreen));
  try {
    const group = view.el.querySelector('[data-testid="settings-group"]')!;
    expect(Array.from(group.querySelectorAll("button")).map((button) => button.getAttribute("aria-label") ?? button.getAttribute("data-nav"))).toEqual([
      Copy.settingsGeneral, Copy.settingsNotifications, Copy.settingsMailboxes, Copy.screener, Copy.awayRow, Copy.settingsSignatures,
    ]);
    expect(menuEntry(group, Copy.settingsGeneral)?.textContent).toContain(words.general);
    expect(menuEntry(group, Copy.settingsNotifications)?.textContent).toContain(words.notifications);
    const mailbox = menuEntry(group, Copy.settingsMailboxes);
    expect(mailbox?.textContent).toContain(words.mailbox);
    expect(mailbox?.textContent).toContain("Fixture mailbox");
    const screener = menuEntry(group, Copy.screener);
    expect(screener?.textContent).toContain(words.waiting);
    expect(screener?.textContent).toContain(words.screened);
    const sign = screener?.querySelector('[data-icon="screener"]');
    expect(sign).not.toBeNull();
    expect(styleOf(sign?.parentElement ?? null)).toMatchObject({ width: 36, height: 36, borderRadius: 999 });
  } finally {
    view.unmount();
    setActiveLocale("en");
  }
});

it("keeps the Screener entry quiet while the first read is incomplete", () => {
  cloudAccount([]);
  const view = mount(h(SettingsScreen));
  try {
    expect(menuEntry(view.el, Copy.screener)?.textContent).toBe(Copy.screener);
  } finally {
    view.unmount();
  }
});

it("keeps the calendar switch and dock at the menu and gives the selected pane its page", () => {
  cloudAccount([cloudBox]);
  const view = mount(h(SettingsScreen));
  try {
    expect(view.el.querySelector('[data-dock] [aria-label="ohcal"]')).not.toBeNull();
    openSection(view, Copy.settingsGeneral);
    expect(view.el.querySelector('[data-dock]')).toBeNull();
    expect(view.el.textContent).toContain(Copy.settingsAppearance);
  } finally {
    view.unmount();
  }
});

it("uses the current account's confirmed mailbox allowance, AI balance and responder settings", async () => {
  cloudAccount([cloudBox]);
  Object.assign(scene.world as object, { autoAct: { on: true } });
  const session = scene.session as ConnectedSession;
  const fetch = session.fetch;
  session.fetch = async (url, init) => {
    if (String(url).endsWith("/account/access")) return Response.json({
      metered: true, access: "open", mailboxes: 5, aiCredits: { remaining: 1200, total: 1000 },
    });
    if (String(url).endsWith("/away-responder")) return Response.json({
      enabled: false, audience: "screened_in", throttle: "per_day",
    });
    return fetch(url, init);
  };
  await readAccess(session);
  const view = mount(h(SettingsScreen));
  try {
    await settle();
    expect(menuEntry(view.el, Copy.settingsMailboxes)?.textContent).toContain("1 of 5");
    expect(menuEntry(view.el, Copy.settingsAi)?.textContent).toContain("1,000 of 1,000 this month");
    expect(menuEntry(view.el, Copy.awayRow)?.textContent).toContain("OffPeople I’ve let in · At most once a day");

    cloudAccount([cloudBox]);
    Object.assign((scene.session as ConnectedSession).profile, { id: "other-profile" });
    view.render(h(SettingsScreen));
    expect(menuEntry(view.el, Copy.settingsMailboxes)?.textContent).not.toContain("1 of 5");
    expect(menuEntry(view.el, Copy.awayRow)?.textContent).toBe(Copy.awayRow);
  } finally {
    view.unmount();
  }
});

it("opens a Settings section from the menu without showing the other sections' controls", async () => {
  cloudAccount([cloudBox]);
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsMailboxes);
    await settle();
    expect(view.el.textContent).toContain("cloud@example.test");
    expect(view.el.textContent).not.toContain(Copy.pictureQuality);
  } finally {
    view.unmount();
  }
});

describe("Settings under a Cloud account while the phone's own engine still runs", () => {
  it("shows the Cloud mailbox's block with Try again and Leave, and Try again reaches its route", async () => {
    holdStandaloneDoor(ownEngine());
    const asked = cloudAccount([cloudBox]);
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsMailboxes);
    await settle();
    const text = view.el.textContent ?? "";
    expect(text).toContain("6 messages have not been filed");
    expect(text).toContain("cloud@example.test");
    const retry = view.el.querySelector('[data-button="Try again now"]') as HTMLButtonElement | null;
    expect(retry, "no Try again for the Cloud mailbox").not.toBeNull();
    expect(view.el.querySelector('[data-button="Leave them where they are"]'), "no Leave for the Cloud mailbox").not.toBeNull();
    act(() => retry!.click());
    await settle();
    expect(asked).toContainEqual({ method: "POST", url: "https://cloud.example/mailboxes/m-cloud/filings/retry", body: JSON.stringify({ folder: "ohmail/Screened" }) });
    expect(view.el.textContent).toContain("6 messages will be tried again on the next pass.");
    view.unmount();
  });

  it("the This phone panel does not show the phone's own mailbox under the other account", async () => {
    holdStandaloneDoor(ownEngine());
    cloudAccount([{ ...cloudBox, filing: undefined }]);
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsMailboxes);
    await settle();
    expect(view.el.textContent).not.toContain("own@phone.test");
    expect(view.el.textContent).toContain("cloud@example.test");
    view.unmount();
  });

  it("CONTROL: under the phone's own account its mailbox is the card", async () => {
    holdStandaloneDoor(ownEngine());
    cloudAccount([]);
    (scene.session as { standalone: boolean }).standalone = true;
    (scene.world as { standalone: boolean }).standalone = true;
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsMailboxes);
    await settle();
    expect(view.el.textContent).toContain("own@phone.test");
    view.unmount();
  });
});

/**
 * A MAILBOX ITS SERVER IS NOT CHECKING SAYS SO ON ITS CARD. The card named who organizes the
 * mailbox and nothing about whether its mail was being fetched. Watched red at the base; the
 * mutation that reds the self-hosted case again is the note always naming Cloud.
 */
describe("a mailbox whose new mail is not being fetched, on its card", () => {
  const SINCE = "2026-11-13T11:10:00.000Z";
  const late = (fetching: PhoneMailbox["fetching"]): PhoneMailbox => ({ ...cloudBox, filing: undefined, fetching });
  const card = async (flavor: string, row: PhoneMailbox): Promise<string> => {
    cloudAccount([row]);
    (scene.session as { profile: { flavor?: string } }).profile.flavor = flavor;
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsMailboxes);
    await settle();
    const text = view.el.textContent ?? "";
    view.unmount();
    return text;
  };
  /* The words up to the time: the time's own form is `late-lines`' and is held there. */
  const upToTheTime = (who: "cloud" | "server"): string =>
    (who === "cloud" ? Copy.notCheckedNoteCloud("<since>") : Copy.notCheckedNoteServer("<since>")).split("<since>")[0]!;

  it("ohmail Cloud is named behind the managed service, with since when", async () => {
    const text = await card("managed", late({ behind: true, since: SINCE }));
    expect(text).toContain(upToTheTime("cloud"));
    expect(await card("managed", late({ behind: true, since: null }))).toContain(Copy.notCheckedNoteCloudNoTime);
  });

  it("a server somebody runs is named your ohmail server, never ohmail Cloud", async () => {
    const text = await card("selfhost", late({ behind: true, since: SINCE }));
    expect(text).toContain(upToTheTime("server"));
    expect(text).not.toContain(upToTheTime("cloud"));
  });

  it.each([
    ["null: this server does not say", null],
    ["absent: an older server", undefined],
    ["not behind", { behind: false, since: SINCE }],
  ] as Array<[string, PhoneMailbox["fetching"]]>)("CONTROL: %s adds no line", async (_what, fetching) => {
    const text = await card("managed", late(fetching));
    expect(text).toContain("cloud@example.test");
    expect(text).not.toContain(upToTheTime("cloud"));
    expect(text).not.toContain(Copy.notCheckedNoteCloudNoTime);
  });
});

/** The Look (#421's rule): a phone on its own keeps its look to itself, so nothing says or offers "all devices". */
describe("the Look on a standalone phone", () => {
  const look = async (standalone: boolean, account: "paper" | "ohmarchy" | null) => {
    holdStandaloneDoor(ownEngine());
    cloudAccount([]);
    (scene.session as { standalone: boolean }).standalone = standalone;
    Object.assign(scene.world as object, {
      standalone, face: { account, known: true, pending: false, applyAll: async () => true, choose: async () => true },
    });
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsGeneral);
    await settle();
    const hints = [...view.el.querySelectorAll("[data-hint]")].map((node) => node.getAttribute("data-hint") ?? "").join(" ");
    const said = { text: `${view.el.textContent ?? ""} ${hints}`, applyAll: menuEntry(view.el, Copy.settingsLookAllDevices) !== undefined ||
      view.el.querySelector('[data-button="Apply on all devices"]') !== null };
    view.unmount();
    return said;
  };

  it.each([null, "ohmarchy"] as const)("account look %s: no Apply on all devices, and the line says this device only", async (account) => {
    const said = await look(true, account);
    expect(said.applyAll).toBe(false);
    expect(said.text).toContain("Applies on this device only.");
    expect(said.text).not.toContain("Applies on all your devices.");
  });

  it("CONTROL: signed in to an account, the press is offered and a stored look says all devices", async () => {
    expect((await look(false, null)).applyAll).toBe(true);
    expect((await look(false, "ohmarchy")).text).toContain("Applies on all your devices.");
  });
});

/** The stores' rules: the privacy policy inside the app, and a way to start deleting a Cloud account. */
describe("Settings links to the operator's pages", () => {
  const LINKS = {
    "Privacy policy": "https://ohmail.app/privacy",
    "Imprint": "https://ohmail.app/imprint",
    "Support page": "https://ohmail.app/support",
  };
  const rows = async (account: "cloud" | "selfhost" | "standalone") => {
    holdStandaloneDoor(ownEngine());
    cloudAccount([]);
    Object.assign((scene.session as { profile: object }).profile, { flavor: account === "cloud" ? "managed" : "selfhost" });
    (scene.session as { standalone: boolean }).standalone = account === "standalone";
    (scene.world as { standalone: boolean }).standalone = account === "standalone";
    const view = mount(h(SettingsScreen));
    openSection(view, Copy.settingsAbout);
    await settle();
    const pressed: Record<string, string> = {};
    for (const label of Object.keys(LINKS)) {
      const row = view.el.querySelector(`[data-nav="${label}"]`) as HTMLButtonElement | null;
      if (row === null) continue;
      scene.opened.length = 0;
      act(() => row.click());
      pressed[label] = scene.opened.join(" ");
    }
    scene.settingsPane = null;
    view.render(h(SettingsScreen));
    const accountEntry = menuEntry(view.el, Copy.settingsAccount);
    if (accountEntry) {
      openSection(view, Copy.settingsAccount);
      const remove = view.el.querySelector(`[data-nav="${Copy.deleteAccountRow}"]`) as HTMLButtonElement | null;
      expect(remove).not.toBeNull();
      scene.opened.length = 0;
      act(() => remove!.click());
      pressed[Copy.deleteAccountRow] = scene.opened.join(" ");
    }
    view.unmount();
    return pressed;
  };

  it("a Cloud account: privacy policy, imprint and support, and Delete account opening the deletion page", async () => {
    expect(await rows("cloud")).toEqual({ ...LINKS, "Delete account": "https://ohmail.app/delete-account" });
  });

  it.each(["selfhost", "standalone"] as const)("%s: the three pages, and no Delete account for an account ohmail.app does not keep", async (account) => {
    expect(await rows(account)).toEqual(LINKS);
  });
});

it.each(["managed", "selfhost", "standalone"] as const)("keeps account devices separate from remembered servers on %s", async (flavor) => {
  cloudAccount([]);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ account: "account", reference: `1_${"x".repeat(48)}` })));
  Object.assign(scene.session as object, {
    standalone: flavor === "standalone",
    fetch,
    profile: { origin: flavor === "managed" ? MANAGED_ORIGIN : "https://mail.example", apiBase: null, accountId: "account", flavor },
  });
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsDevices);
    expect(view.el.querySelector(`[data-nav="${Copy.serversTitle}"]`)).not.toBeNull();
    const manage = view.el.querySelector<HTMLElement>('[data-nav="Manage account devices"]');
    if (flavor === "standalone") {
      expect(manage).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(manage).not.toBeNull();
      await act(async () => manage!.click());
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/auth/session?settingsPane=devices"), expect.anything());
      const destination = new URL(scene.opened.at(-1)!);
      expect(destination.origin).toBe(flavor === "managed" ? "https://ohmail.app" : "https://mail.example");
      expect(destination.hash).toBe("#/settings/devices");
      expect(destination.searchParams.get("settingsHandoff")).toBe(`1_${"x".repeat(48)}`);
    }
  } finally {
    view.unmount();
  }
});

it("keeps the browser closed when the Devices response names a different account", async () => {
  cloudAccount([]);
  Object.assign(scene.session as object, {
    fetch: vi.fn(async () => new Response(JSON.stringify({ account: "other", reference: `1_${"x".repeat(48)}` }))),
    profile: { origin: "https://mail.example", apiBase: null, accountId: "account", flavor: "selfhost" },
  });
  const view = mount(h(SettingsScreen));
  try {
    openSection(view, Copy.settingsDevices);
    await act(async () => view.el.querySelector<HTMLElement>(`[data-nav="${Copy.settingsManageDevices}"]`)!.click());
    expect(scene.opened).toEqual([]);
    expect(view.el.textContent).toContain(Copy.settingsDevicesFailed);
  } finally {
    view.unmount();
  }
});
