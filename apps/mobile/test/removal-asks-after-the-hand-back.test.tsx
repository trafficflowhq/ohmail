/** @vitest-environment jsdom */
/**
 * STOP AND REMOVE ASKS AFTER THE HAND-BACK TOO, rendered. The press reads the store first, and before a write
 * is tried the store cannot know the mailbox is full: the single press went on, the hand-back's write was
 * refused, and the forget deleted the store with the decisions in it. The forget now keeps the store and
 * says what it would drop; the row asks, Keep the mailbox first (it opens the mailbox again), and only Remove
 * anyway removes it. A settings risk the first confirm named is not asked about again.
 */
import { createElement as h, type ReactNode } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";
import { EN } from "../src/copy.en";
import { refuse } from "../src/refusal";
import type { ForgetAttempt } from "../src/net/connection";
import type { ServerProfile } from "../src/state/servers";

const scene = vi.hoisted(() => ({ conn: null as unknown, routes: [] as string[] }));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo-router", () => ({
  router: { push: (to: string) => void scene.routes.push(to), replace: (to: string) => void scene.routes.push(to), canGoBack: () => true },
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
vi.mock("../src/net/connection", () => ({ useConnection: () => scene.conn }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: { accent: "#000", ink2: "#000" }, radius: { dot: 1 } }) }));
vi.mock("../src/ui/base", () => {
  const div = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Button: (p: { label: string; onPress?: () => void }) => h("button", { "data-button": p.label, onClick: p.onPress }, p.label),
    Txt: (p: { children?: ReactNode }) => h("span", null, p.children),
    Panel: div, Screen: div, Scroller: div, Section: div, Tap: div, TapRow: div,
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/Doors", () => ({ Doors: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));

import ServersScreen from "../app/servers";
import { LOCAL_ENGINE_ORIGIN } from "../src/engine/boot";
import { forgetOrganizerSessionForTests, holdStandaloneDoor } from "../src/engine/organizer-session";
import type { StandaloneEngine } from "../src/engine/standalone-door";

const HERE: ServerProfile = {
  id: "p-here", origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
  refreshToken: null, refreshAttempt: null, apiBase: null, pin: null,
};

/** The engine's reading before the press: `none` is the single press. */
function engineSays(said: "answer" | "none"): void {
  holdStandaloneDoor({ settingsLeftOnlyHere: async () => said } as unknown as StandaloneEngine);
}

/** The connection as the row sees it: every forget's options, answered in turn; every switch. */
function connection(drafts: number, answers: ForgetAttempt[]) {
  const forgets: Array<{ anyway?: boolean } | undefined> = [];
  const switches: string[] = [];
  scene.conn = {
    state: { k: "idle" }, profiles: [HERE], activeId: HERE.id, syncing: false, syncError: null,
    unsentDraftsHere: () => drafts,
    forget: async (_id: string, opts?: { anyway?: boolean }) => { forgets.push(opts); return answers.shift() ?? { ok: true }; },
    switchTo: async (id: string) => { switches.push(id); return { ok: true }; },
  };
  return { forgets, switches };
}

const KEPT: ForgetAttempt = { ok: false, reason: refuse("serversStopHereSettingsUnsaved"), settingsKept: "unsaved" };
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const press = async (el: HTMLElement, label: string) => {
  const button = el.querySelector(`[data-button="${label}"]`) as HTMLButtonElement | null;
  expect(button, `no ${label}`).not.toBeNull();
  act(() => button!.click());
  await settle();
};
const buttons = (el: HTMLElement) => [...el.querySelectorAll("[data-button]")].map((b) => b.getAttribute("data-button"));

afterEach(() => { forgetOrganizerSessionForTests(); scene.routes.splice(0); document.body.innerHTML = ""; });

describe("a removal whose hand-back could not save the settings", () => {
  it("the single press: the store is kept and the row asks, Keep first; Remove anyway answers it", async () => {
    engineSays("none");
    const asked = connection(0, [KEPT]);
    const view = mount(h(ServersScreen));
    await settle();
    await press(view.el, EN.serversStopHere);
    const confirm = { text: view.el.textContent ?? "", buttons: buttons(view.el).slice(-2) };
    await press(view.el, EN.serversStopHereAnyway);
    expect({ forgets: asked.forgets, said: confirm.text.includes(EN.serversStopHereSettingsUnsaved), buttons: confirm.buttons, routes: scene.routes })
      .toEqual({
        forgets: [{ anyway: false }, { anyway: true }], said: true,
        buttons: [EN.serversStopHereKeep, EN.serversStopHereAnyway], routes: ["/welcome"],
      });
    view.unmount();
  });

  it("Keep the mailbox opens it again and removes nothing", async () => {
    engineSays("none");
    const asked = connection(0, [KEPT]);
    const view = mount(h(ServersScreen));
    await settle();
    await press(view.el, EN.serversStopHere);
    await press(view.el, EN.serversStopHereKeep);
    expect({ forgets: asked.forgets.length, switches: asked.switches, asking: view.el.textContent?.includes(EN.serversStopHereSettingsUnsaved) })
      .toEqual({ forgets: 1, switches: [HERE.id], asking: false });
    view.unmount();
  });

  it("a risk the first confirm named is the person's answer: Remove anyway is not asked again", async () => {
    engineSays("answer");
    const asked = connection(0, []);
    const view = mount(h(ServersScreen));
    await settle();
    await press(view.el, EN.serversStopHere);
    await press(view.el, EN.serversStopHereAnyway);
    expect(asked.forgets).toEqual([{ anyway: true }]);
    view.unmount();
  });

  it("CONTROL: a drafts-only confirm leaves the settings to the hand-back", async () => {
    engineSays("none");
    const asked = connection(2, []);
    const view = mount(h(ServersScreen));
    await settle();
    await press(view.el, EN.serversStopHere);
    await press(view.el, EN.serversStopHereDelete);
    expect(asked.forgets).toEqual([{ anyway: false }]);
    view.unmount();
  });
});
