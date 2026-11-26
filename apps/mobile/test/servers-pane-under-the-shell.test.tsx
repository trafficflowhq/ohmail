/** @vitest-environment jsdom */
/**
 * TODAY'S SERVERS PANE UNDER THE SHELL OPENS THE FIRST SCREEN THE GATE OPENS. In the calendar app (always the shell)
 * and in a mail build under the shell, the gate's first screen is the door's ways in; the pane's three ways out with
 * nothing left to open (Back where the phone is held with nothing to reopen, Back with no stack under nothing paired,
 * the last pairing forgotten) open that same door, never a second first screen. Rendered in the calendar app, as its
 * switch module names it; the mail app's own screens keep their welcome (`servers-pane-is-never-a-dead-end.test.ts`).
 */
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const scene = vi.hoisted(() => ({
  conn: null as unknown,
  stack: [] as string[],
}));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo-router", () => ({
  router: {
    canGoBack: () => scene.stack.length > 1,
    back: () => void scene.stack.pop(),
    replace: (to: string) => void scene.stack.splice(-1, 1, to),
    push: (to: string) => void scene.stack.push(to),
  },
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
/* The calendar app, as its switch module names it; no other native module is here. */
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => (name === "OhmailSwitch"
    ? { appId: "app.ohcal", addListener: () => ({ remove: () => undefined }), takeArrival: async () => null }
    : null),
}));
vi.mock("expo-crypto", () => ({}));
vi.mock("react-native-svg", () => ({ default: () => null, Circle: () => null, Path: () => null, Rect: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => null }));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/state/servers-native", () => ({ nativeServerProfiles: () => null, nativeFamilyDigest: async () => "", secureKV: () => null }));
vi.mock("../src/engine/native", () => ({ nativeEngineDeps: () => null }));
vi.mock("../src/net/connection", async (original) => ({
  ...((await original()) as object),
  useConnection: () => scene.conn,
}));
vi.mock("../src/theme", () => ({ useTheme: () => ({ face: "paper", scheme: "light", c: { accent: "#000", ink2: "#000", ink3: "#000" }, radius: { dot: 1 } }) }));
vi.mock("../src/ui/base", () => {
  const div = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Button: (p: { label: string; onPress?: () => void }) => h("button", { onClick: p.onPress }, p.label),
    Tap: (p: { accessibilityLabel: string; onPress?: () => void; children?: ReactNode }) =>
      h("button", { "aria-label": p.accessibilityLabel, onClick: p.onPress }, p.children),
    useTopPad: () => 0,
    Txt: (p: { children?: ReactNode; accessibilityRole?: string }) =>
      h("span", { role: p.accessibilityRole === "header" ? "heading" : undefined }, p.children),
    ViewHead: (p: { title: string }) => h("h1", null, p.title),
    Panel: div, Screen: div, Scroller: div, Section: div, TapRow: div,
  };
});
/* The bar's one way back, as the pane hands it. */
vi.mock("../src/ui/chrome", () => ({
  DetailBar: (p: { back?: () => void }) => (p.back ? h("button", { onClick: p.back }, EN.back) : null),
  PaneTop: () => null,
}));
vi.mock("../src/ui/Doors", () => ({ Doors: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));

import ServersScreen from "../app/servers";
import { EN } from "../src/copy.en";
import { MAIL_SURFACE, type ConnectionState } from "../src/net/connection";
import { refuse } from "../src/refusal";

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

/** A pairing whose credential is gone: nothing to open again. */
const ENDED = { id: "row-1", origin: "https://mail.example.test", flavor: "selfhost", accountId: "account-1", refreshToken: null, pin: null };

function connection(state: ConnectionState, profiles: object[], activeId: string | null = null) {
  scene.conn = {
    state, profiles, activeId, syncing: false, syncError: null, signOutNotices: [],
    unsentDraftsHere: () => 0,
    forget: async () => ({ ok: true }),
    switchTo: async () => ({ ok: false, reason: refuse("pairEnded") }),
  };
}

async function press(el: HTMLElement, label: string): Promise<void> {
  const button = Array.from(el.querySelectorAll("button")).find((el) => (el.getAttribute("aria-label") ?? el.textContent) === label);
  expect(button, `no ${label}`).toBeDefined();
  act(() => button!.click());
  await settle();
}

afterEach(() => {
  scene.conn = null;
  scene.stack.splice(0);
  document.body.innerHTML = "";
});

describe("today's Servers pane under the shell", () => {
  it("keeps a remembered server visible after disconnect without calling it connected", () => {
    connection({ k: "idle" }, [ENDED], ENDED.id);
    const view = mount(h(ServersScreen));
    try {
      expect(view.el.textContent).toContain(ENDED.origin);
      expect(view.el.textContent).not.toContain(EN.serversActive);
    } finally {
      view.unmount();
    }
  });

  it("shows the same accessible Servers heading in ordinary and recovery states", () => {
    for (const state of [{ k: "idle" }, { k: "refused", reason: refuse("pairEnded") }] as const) {
      connection(state, [ENDED]);
      const view = mount(h(ServersScreen));
      try {
        const headings = [...view.el.querySelectorAll("h1, [role='heading']")];
        expect(headings.map((heading) => heading.textContent)).toEqual([EN.serversTitle]);
      } finally {
        view.unmount();
      }
    }
  });

  it("opens the door's ways in on each way out with nothing left to open", async () => {
    expect(MAIL_SURFACE, "the calendar app is the shell").toBe("shell");
    const reached: string[] = [];

    // Held at the pane by a refusal, with nothing to open again: Back.
    connection({ k: "refused", reason: refuse("pairEnded") }, [ENDED]);
    scene.stack.push("/", "/servers");
    let view = mount(h(ServersScreen));
    await press(view.el, EN.back);
    reached.push(scene.stack.at(-1)!);
    view.unmount();

    // Nothing paired and no stack under the pane: Back.
    connection({ k: "idle" }, []);
    scene.stack.splice(0, scene.stack.length, "/servers");
    view = mount(h(ServersScreen));
    await press(view.el, EN.back);
    reached.push(scene.stack.at(-1)!);
    view.unmount();

    // The last pairing forgotten.
    connection({ k: "idle" }, [{ ...ENDED, refreshToken: "rt-1" }]);
    scene.stack.splice(0, scene.stack.length, "/servers");
    view = mount(h(ServersScreen));
    await press(view.el, EN.serversForget);
    reached.push(scene.stack.at(-1)!);
    view.unmount();

    expect(reached).toEqual(["/door", "/door", "/door"]);
  });
});
