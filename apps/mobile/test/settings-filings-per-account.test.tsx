/** @vitest-environment jsdom */
/**
 * SETTINGS SHOWS THE LIVE ACCOUNT'S WAITING FILINGS, rendered. The phone's own engine outlives a
 * switch to another account; Settings read it unscoped, so under a Cloud or paired account the
 * "This phone" panel drew the phone's own mailbox, and the filings block it carried looked for that
 * mailbox among the other account's rows and drew nothing — the Ohbox strip sent people to a page
 * with no Try again and no Leave.
 */
import { createElement as h, type ReactNode } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";
import { MANAGED_ORIGIN } from "../src/net/pairing";
import type { PhoneMailbox } from "../src/net/mailboxes";

const scene = vi.hoisted(() => ({
  world: null as unknown,
  session: null as unknown,
  opened: [] as string[],
  settingsPane: null as string | null,
}));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Linking: { openURL: async (url: string) => { scene.opened.push(url); } },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-router", () => ({ router: { push: (route: { params?: { pane?: string } }) => {
  scene.settingsPane = route.params?.pane ?? null;
} }, useLocalSearchParams: () => ({ pane: scene.settingsPane ?? undefined }) }));
vi.mock("../src/theme", async () => {
  const { accountGovernsFace, accountWideOffered } = await import("../src/theme/face");
  return { accountGovernsFace, accountWideOffered, useTheme: () => ({ mail: true }) };
});
vi.mock("../src/state/store", () => ({
  usePrefs: () => ({ themePref: "system", setTheme: () => undefined, facePin: null, setFacePin: () => undefined,
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
    Txt: (p: { children?: ReactNode }) => h("span", null, p.children),
    Chip: div, Panel: div, Rule: () => null, Screen: div, Scroller: div, Section: div, TapRow: div,
  };
});
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/MoreNav", () => ({
  Nav: (p: { label: string; sub?: string; onPress: () => void }) => h("button", { "data-nav": p.label, onClick: p.onPress }, p.label, p.sub),
}));
vi.mock("../src/ui/Field", () => ({ Field: () => null }));
vi.mock("../src/engine/backup-exclusion", () => ({ backupExclusion: () => null, subscribeBackupExclusion: () => () => undefined }));
vi.mock("../src/engine/engine-artifact", () => ({ phoneEngineStart: () => () => undefined }));
vi.mock("../src/engine/notification-permission-native", () => ({ openNotificationSettings: async () => undefined }));
vi.mock("../src/ui/NotifyPermission", () => ({ NotifyPermission: () => null }));
vi.mock("../src/ui/useNotifyPermission", () => ({ useNotifyPermission: () => ({ gate: async () => undefined }) }));
vi.mock("../src/i18n/LocaleProvider", async () => ({
  useLocale: (await import("../src/i18n/locale")).activeLocale,
  useLocaleControls: () => null,
}));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/more-move", () => ({ YieldToMore: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/Segmented", () => ({ Segmented: () => null }));
vi.mock("../src/ui/AutoActPanel", () => ({ AutoActPanel: () => null, readsOnly: () => false }));
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
import { forgetOrganizerSessionForTests, holdStandaloneDoor } from "../src/engine/organizer-session";
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
  firstSyncStopFolder: null,
  filing: { due: 6, deferred: 6, stuck: 6, stuckSince: "2026-10-24T09:00:00.000Z", stuckRefusalClass: "no_such_folder",
    lastRefusalClass: "no_such_folder", nextAttemptAt: "2026-10-24T15:00:00.000Z", asOf: null },
};

function cloudAccount(rows: PhoneMailbox[]) {
  scene.settingsPane = null;
  const asked: { method: string; url: string; body?: string }[] = [];
  scene.session = {
    standalone: false,
    profile: { origin: "https://cloud.example", apiBase: null },
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
    boot: { connection: null, firstSync: null, setAside: null },
    face: { account: null, known: false, pending: false, applyAll: () => undefined },
    folders: { storable: false },
    autoAct: null,
    mailboxes: { known: true, rows },
  };
  return asked;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function openSection(view: ReturnType<typeof mount>, title: string) {
  const entry = Array.from(view.el.querySelectorAll("button")).find((button) => button.textContent === title);
  expect(entry, title).toBeDefined();
  act(() => entry!.click());
  view.render(h(SettingsScreen));
}

afterEach(() => {
  forgetOrganizerSessionForTests();
  document.body.innerHTML = "";
  scene.opened.length = 0;
  scene.settingsPane = null;
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
    expect(groups[1]?.querySelector('button')?.textContent).toBe(devices);
    openSection(view, devices);
    expect(view.el.querySelector(`[data-nav="${servers}"]`)).not.toBeNull();
    expect(view.el.querySelector('[data-testid="settings-group"]')).toBeNull();
  } finally {
    view.unmount();
    setActiveLocale("en");
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
    const said = { text: view.el.textContent ?? "", applyAll: view.el.querySelector('[data-button="Apply on all devices"]') !== null };
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
    const accountEntry = view.el.querySelector(`[data-nav="${Copy.settingsAccount}"]`);
    if (accountEntry !== null) {
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
