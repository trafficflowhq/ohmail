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
import type { PhoneMailbox } from "../src/net/mailboxes";

const scene = vi.hoisted(() => ({
  world: null as unknown,
  session: null as unknown,
}));

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/theme", () => ({ accountGovernsFace: () => false, accountWideOffered: () => false }));
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
vi.mock("../src/ui/MoreNav", () => ({ Nav: () => null }));
vi.mock("../src/ui/Field", () => ({ Field: () => null }));
vi.mock("../src/engine/backup-exclusion", () => ({ backupExclusion: () => null, subscribeBackupExclusion: () => () => undefined }));
vi.mock("../src/engine/engine-artifact", () => ({ phoneEngineStart: () => () => undefined }));
vi.mock("../src/engine/notification-permission-native", () => ({ openNotificationSettings: async () => undefined }));
vi.mock("../src/ui/NotifyPermission", () => ({ NotifyPermission: () => null }));
vi.mock("../src/ui/useNotifyPermission", () => ({ useNotifyPermission: () => ({ gate: async () => undefined }) }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en", useLocaleControls: () => null }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/Segmented", () => ({ Segmented: () => null }));
vi.mock("../src/ui/AutoActPanel", () => ({ AutoActPanel: () => null, readsOnly: () => false }));
vi.mock("../src/ui/AutoFiledPanel", () => ({ AutoFiledPanel: () => null }));
vi.mock("../src/ui/ProfileImportCard", () => ({ SavedSettingsPanel: () => null }));
vi.mock("../src/ui/WaitingStrip", () => ({ WaitingStrip: () => null }));
vi.mock("../src/compose/attach", () => ({ IMAGE_QUALITY_LEVELS: [] }));
vi.mock("../src/engine/diagnostics", () => ({ writePhoneDiagnostics: async () => null }));
vi.mock("../src/engine/diagnostics-native", () => ({ nativePhoneDiagnosticDeps: () => ({}), shareDiagnosticFile: async () => true }));

import SettingsScreen from "../app/settings";
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
  organizedByThisInstall: true, organizerState: null, status: "connected", junkFolder: null, smtpMaxSizeBytes: null,
  firstSyncStopFolder: null,
  filing: { due: 6, deferred: 6, stuck: 6, stuckSince: "2026-10-24T09:00:00.000Z", stuckRefusalClass: "no_such_folder",
    lastRefusalClass: "no_such_folder", nextAttemptAt: "2026-10-24T15:00:00.000Z", asOf: null },
};

function cloudAccount(rows: PhoneMailbox[]) {
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

afterEach(() => { forgetOrganizerSessionForTests(); document.body.innerHTML = ""; });

describe("Settings under a Cloud account while the phone's own engine still runs", () => {
  it("shows the Cloud mailbox's block with Try again and Leave, and Try again reaches its route", async () => {
    holdStandaloneDoor(ownEngine());
    const asked = cloudAccount([cloudBox]);
    const view = mount(h(SettingsScreen));
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
    await settle();
    expect(view.el.textContent).toContain("own@phone.test");
    view.unmount();
  });
});
