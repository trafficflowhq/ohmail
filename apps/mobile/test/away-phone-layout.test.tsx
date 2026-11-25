/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const responder = vi.hoisted(() => ({ session: null as unknown, hold: vi.fn() }));
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("expo-router", () => ({ useNavigation: () => ({ dispatch: vi.fn() }) }));
vi.mock("expo-router/react-navigation", () => ({ usePreventRemove: () => undefined }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ state: responder.session ? { k: "live", session: responder.session } : { k: "idle" } }) }));
vi.mock("../src/state/world", () => ({ useWorld: () => ({ standalone: true }) }));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/more-move", () => ({ YieldToMore: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/more-pane", () => ({ useUnsavedHold: responder.hold }));
vi.mock("../src/theme/mail", () => ({
  MailAppearance: ({ children }: { children: ReactNode }) => h("div", { "data-mail-appearance": "" }, children),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Panel: rnDom.View, Screen: rnDom.View, Scroller: rnDom.ScrollView, Section: rnDom.Text, Chip: rnDom.View,
    Txt: rnDom.Text, Rule: () => null,
    Tap: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: {
      children: ReactNode; onPress: () => void; disabled?: boolean;
      accessibilityLabel?: string; accessibilityState?: { checked: boolean };
    }) => h("button", {
      onClick: onPress, disabled, "aria-label": accessibilityLabel, "aria-pressed": accessibilityState?.checked,
    }, children), Button: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
      h("button", { onClick: onPress, disabled }, label),
    ViewHead: ({ title }: { title: string }) => h("h1", null, title),
  };
});
vi.mock("../src/ui/chrome", () => ({
  PaneTop: () => null,
  DetailBar: ({ title, backLabel, backCapsule }: { title?: string; backLabel?: string; backCapsule?: boolean }) =>
    h("button", { "data-capsule": backCapsule }, backLabel ?? title),
}));
vi.mock("../src/ui/Field", () => ({ Field: ({ label }: { label: string }) => h("textarea", { "aria-label": label }) }));
vi.mock("../src/ui/Segmented", () => ({
  Segmented: ({ segments, value, onChange }: { segments: { label: string; value: string }[]; value: string; onChange: (value: string) => void }) =>
    h("div", null, segments.map((choice) => h("button", { key: choice.value, "aria-pressed": choice.value === value, onClick: () => onChange(choice.value) }, choice.label))),
}));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  SheetRow: ({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) =>
    h("button", { onClick: onPress, "aria-pressed": on }, label),
}));

import AwayScreen from "../app/away";
import { Copy } from "../src/copy";

it("keeps the away form inside the phone Settings appearance in either presentation", () => {
  const view = mount(h(AwayScreen));
  try {
    const page = view.el.querySelector("[data-mail-appearance]");
    expect(page?.querySelector("h1")?.textContent).toBe(Copy.awayTitle);
    expect(page?.querySelector('[data-capsule="true"]')?.textContent).toBe(Copy.settings);
    expect(page?.querySelector(`[aria-label="${Copy.awayBodyLabel}"]`)).not.toBeNull();
    view.render(h(AwayScreen, { inPane: true }));
    expect(view.el.querySelector("[data-mail-appearance] h1")?.textContent).toBe(Copy.awayTitle);
    expect(view.el.querySelector('[data-capsule="true"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

const saved = {
  enabled: false, body: "Back Monday", startsAt: "2036-05-01T08:00:00.000Z",
  endsAt: "2036-06-01T22:00:00.000Z", audience: "screened_in",
  throttle: "per_week", piles: ["INBOX", "ohmail/News"], updatedAt: "2036-04-01T08:00:00.000Z",
};
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("button")].find((node) => node.textContent === label);

it("holds a changed audience until Save, carries the other fields, and says when the organizer still has to apply it", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(JSON.stringify(saved), { status: init?.method === "PUT" ? 202 : 200 }));
  responder.session = { profile: { origin: "https://mail.example", apiBase: null }, fetch };
  const view = mount(h(AwayScreen, { inPane: true }));
  try {
    await act(async () => {});
    const everyone = button(view.el, Copy.awayEveryone);
    expect(everyone).toBeDefined();
    act(() => everyone!.click());
    expect(responder.hold).toHaveBeenLastCalledWith(true, expect.any(Function));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => button(view.el, Copy.awaySave)!.click());
    const { updatedAt: _updatedAt, ...fields } = saved;
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ ...fields, audience: "everyone" });
    expect(view.el.textContent).toContain(Copy.awayAsked);
    expect(view.el.textContent).not.toContain(Copy.awaySaved);
    expect(button(view.el, Copy.awayScreenedIn)?.getAttribute("aria-pressed")).toBe("true");
    expect(responder.hold).toHaveBeenLastCalledWith(false, expect.any(Function));
  } finally {
    view.unmount();
    responder.session = null;
  }
});

it("saves pile and rate edits and clears the Screener pile when the audience narrows", async () => {
  const row = { ...saved, audience: "everyone", piles: ["INBOX", "ohmail/Screener"] };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.method === "PUT" ? JSON.parse(String(init.body)) : row;
    return new Response(JSON.stringify(body));
  });
  responder.session = { profile: { origin: "https://mail.example", apiBase: null }, fetch };
  const view = mount(h(AwayScreen, { inPane: true }));
  try {
    await act(async () => {});
    const screener = button(view.el, Copy.awayPileScreener)!;
    expect(screener.getAttribute("aria-pressed")).toBe("true");
    act(() => button(view.el, Copy.awayScreenedIn)!.click());
    expect(screener.disabled).toBe(true);
    expect(screener.getAttribute("aria-pressed")).toBe("false");
    act(() => button(view.el, Copy.awayPileReceipts)!.click());
    act(() => button(view.el, Copy.awayPerWeek)!.click());
    act(() => button(view.el, Copy.awayPerMessage)!.click());
    expect(responder.hold).toHaveBeenLastCalledWith(true, expect.any(Function));
    await act(async () => button(view.el, Copy.awaySave)!.click());
    const { updatedAt: _updatedAt, ...fields } = row;
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      ...fields, audience: "screened_in", piles: ["INBOX", "ohmail/Receipts"], throttle: "per_message",
    });
    expect(view.el.textContent).toContain(Copy.awaySaved);
  } finally {
    view.unmount();
    responder.session = null;
  }
});
