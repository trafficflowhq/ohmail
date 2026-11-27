/** @vitest-environment jsdom */
/**
 * THE DECISION BAR ON THE iPHONE SE (375 x 667), RENDERED. In the scrolling shape the bar drops
 * its side padding so the capsules' row can run to both edges; the hint lines under it must keep
 * their own inset, or they touch the glass. The row opens scrolled so the AI's suggested capsule
 * is whole on screen: no scroll indicator says that more of the row lies to the right.
 */
import { act, createElement, useEffect, useImperativeHandle, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const shim = vi.hoisted(() => ({
  window: { width: 375, height: 667 },
  layouts: {} as Record<string, { x: number; width: number }>,
  alert: vi.fn(),
  paper: false,
  world: {} as object,
  scrolls: [] as { x?: number; animated?: boolean }[],
}));

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  /* A view reports the layout the test gives its testID, once, as the device's first pass does. */
  const measured = (name: string) =>
    function Host(p: { testID?: string; style?: unknown; children?: ReactNode; onLayout?: (e: unknown) => void; ref?: unknown; accessibilityLabel?: string; accessibilityRole?: string }) {
      const { onLayout, testID } = p;
      useImperativeHandle(p.ref as never, () => ({ scrollTo: (o: { x?: number; animated?: boolean }) => shim.scrolls.push(o) }));
      useEffect(() => {
        const box = (testID && shim.layouts[testID]) || { x: 0, width: 0 };
        onLayout?.({ nativeEvent: { layout: { x: box.x, y: 0, width: box.width, height: 44 } } });
      }, []);
      const s = Array.isArray(p.style) ? Object.assign({}, ...p.style.filter(Boolean)) : (p.style ?? {});
      return createElement("div", { "data-rn": name, "data-testid": testID, "data-style": JSON.stringify(s), "data-label": p.accessibilityLabel, "data-role": p.accessibilityRole }, p.children);
    };
  return {
    ...rnDom,
    Alert: { alert: shim.alert },
    View: measured("View"),
    ScrollView: measured("ScrollView"),
    useWindowDimensions: () => ({ ...shim.window, scale: 2, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: shim.paper,
    c: new Proxy({}, { get: () => "#000000" }),
    radius: new Proxy({}, { get: () => 8 }),
    lift: () => ({}),
    liftUp: () => ({}),
    ringed: false,
  }),
}));
vi.mock("../src/theme/lift", () => ({ ringOnLift: () => ({}) }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const Txt = (p: { style?: unknown; testID?: string; children?: ReactNode }) => createElement(rnDom.Text, { style: p.style, testID: p.testID }, p.children);
  const Tap = (p: Parameters<typeof rnDom.Pressable>[0]) => createElement(rnDom.Pressable, p);
  const Container = ({ children }: { children?: ReactNode }) => children;
  const Nothing = () => null;
  const Scroller = ({ children, head }: { children?: ReactNode; head?: ReactNode }) =>
    createElement("div", null, head, createElement(rnDom.ScrollView, null, children));
  return { Txt, Tap, Badge: Nothing, Button: Nothing, Panel: Nothing, Screen: Container, Scroller };
});
vi.mock("../src/ui/glass/GlassPill", () => ({
  GlassPill: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", { role: "dialog" }, children) : null,
  SheetRow: ({ label, onPress }: { label: string; onPress: () => void }) => createElement("button", { onClick: onPress, "data-label": label }, label),
}));
vi.mock("../src/ui/MailAvatar", () => ({ MailAvatar: () => null }));
vi.mock("../src/ui/Segmented", () => ({ Segmented: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ heightClass: shim.window.height < 480 ? "compact" : "regular" }) }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: () => null }));
vi.mock("../src/ui/body-note", () => ({ mailboxStatusOf: () => null, withheldNote: () => null }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/MessageReader", () => ({ AttachmentTiles: () => null }));
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/not-organizing", () => ({ noneOrganizedWhy: () => null }));
vi.mock("../src/state/relay", () => ({ relayMarkFor: () => null, senderSheetLine: () => null }));
vi.mock("../src/state/live", () => ({ decideLinesOf: () => ({}), domainScopeOffered: () => true }));
vi.mock("../src/state/world", () => ({ useBodies: () => ({}), useFilesStamp: () => 0, useWorld: () => shim.world }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import { mount, styleOf } from "./_rendered-dom";
import { DecisionBar, SenderDetail } from "../src/ui/SenderDetail";
import { destDone, destLabel, DESTINATIONS, type Destination } from "../src/state/model";

import { Copy } from "../src/copy";

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  shim.alert.mockClear();
  shim.paper = false;
  shim.world = {};
  shim.layouts = {};
  shim.scrolls = [];
});

function bar(window: { width: number; height: number }, suggested: Destination | null = null) {
  shim.window = window;
  const m = mount(
    createElement(DecisionBar, {
      scope: "domain",
      domainOffered: true,
      nobody: false,
      also: "Also files 3 other senders at example.org.",
      unsub: "Screen out also unsubscribes you from this list.",
      listClaim: "Screen out files these letters alone.",
      ruleLine: "Files every message from this sender.",
      suggested,
      onScope: () => undefined,
      onDecide: () => undefined,
    }),
  );
  mounted.push(m);
  return m.el;
}

const n = (v: unknown) => (typeof v === "number" ? v : 0);
/** A text line's distance from the bar's edge on one side: every padding and margin up to the bar. */
function inset(line: Element, root: Element, side: "Left" | "Right"): number {
  let sum = 0;
  for (let el: Element | null = line; el !== null && el !== root; el = el.parentElement) {
    const s = styleOf(el);
    sum += n(s[`padding${side}`] ?? s.paddingHorizontal ?? s.padding) + n(s[`margin${side}`] ?? s.marginHorizontal ?? s.margin);
  }
  return sum;
}
/** The bar's own text lines: not the capsules' labels, which ride the row. */
const lines = (el: Element) => [...el.querySelectorAll('[data-rn="Text"]')].filter((t) => t.closest('[data-testid^="decide-capsule-"]') === null);

describe("the hint lines under the decision bar keep a side inset", () => {
  it("at 375 x 667 (the scrolling row) every line stands at least 14 from both edges", () => {
    const el = bar({ width: 375, height: 667 });
    expect(el.querySelector('[data-rn="ScrollView"]'), "the scrolling shape").not.toBeNull();
    const found = lines(el);
    expect(found.map((t) => t.getAttribute("data-testid"))).toEqual(["decide-domain-also", "decide-unsub", "decide-list-claim"]);
    for (const t of found) {
      expect(inset(t, el, "Left"), t.getAttribute("data-testid") ?? "").toBeGreaterThanOrEqual(14);
      expect(inset(t, el, "Right"), t.getAttribute("data-testid") ?? "").toBeGreaterThanOrEqual(14);
    }
  });

  it("at 375 x 812 (the wrap) the lines keep the bar's own 14, not twice it", () => {
    const el = bar({ width: 375, height: 812 });
    expect(el.querySelector('[data-rn="ScrollView"]')).toBeNull();
    const found = lines(el);
    expect(found).toHaveLength(4);
    for (const t of found) {
      expect(inset(t, el, "Left")).toBe(14);
      expect(inset(t, el, "Right")).toBe(14);
    }
  });
});

describe("the scrolling row opens on the AI's suggestion", () => {
  it("a suggested capsule past the row's right edge is scrolled whole into view, once, without animation", () => {
    // Five capsules ~640 wide in a 375 row: Spam at 520..640 in the capsules' strip, 534..654 in the row.
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-spam": { x: 520, width: 120 } };
    bar({ width: 375, height: 667 }, "spam");
    expect(shim.scrolls).toEqual([{ x: 654 + 14 - 375, animated: false }]);
  });

  it("a suggested capsule already whole on screen leaves the row at its beginning", () => {
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-ohbox": { x: 0, width: 110 } };
    bar({ width: 375, height: 667 }, "ohbox");
    expect(shim.scrolls).toEqual([]);
  });

  it("without a suggestion the row starts at its beginning", () => {
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-spam": { x: 520, width: 120 } };
    bar({ width: 375, height: 667 }, null);
    expect(shim.scrolls).toEqual([]);
  });
});

it.each(["International workshop registration and customer enquiries", undefined])("puts known delivery after the reason and before the held mail (%s)", (mailboxLabel) => {
  shim.paper = true;
  shim.window = { width: 390, height: 844 };
  const row = {
    routeKey: "sender", scope: "sender", name: "A sender", address: "sender@example.invalid",
    held: [], reached: 0, firstContact: undefined, mailboxLabel,
  };
  shim.world = {
    worldKey: "account",
    screener: { waiting: [row] },
    mailboxes: { organizer: null, known: true },
    actions: { unsubClaimOf: () => "none", unsubscribeIdsOf: () => [] },
  };
  const view = mount(createElement(SenderDetail, { seg: "waiting", routeKey: row.routeKey }));
  mounted.push(view);
  const chip = view.el.querySelector('[data-label^="Delivered to "]');
  if (mailboxLabel === undefined) {
    expect(chip).toBeNull();
    return;
  }
  expect(chip?.textContent).toBe(Copy.deliveredTo(mailboxLabel));
  expect(chip?.getAttribute("data-label")).toBe(Copy.deliveredTo(mailboxLabel));
  const content = view.el.textContent!;
  const at = content.indexOf(Copy.deliveredTo(mailboxLabel));
  expect(at).toBeGreaterThan(content.indexOf(Copy.senderFirstContact));
  expect(at).toBeLessThan(content.indexOf(Copy.heldCaption(0)));
});

it.each(["spam", "screened"] as const)("files as %s immediately after showing the inline unsubscribe hint", (dest) => {
  const row = {
    routeKey: "sender", scope: "sender", name: "A sender", address: "sender@example.invalid",
    held: [], reached: 0, firstContact: true,
  };
  const waiting = [row];
  const decide = vi.fn();
  const remember = vi.fn();
  const close = vi.fn();
  shim.world = {
    worldKey: "account",
    screener: { waiting },
    mailboxes: { organizer: null, known: true },
    screenerConfirmation: { acknowledged: 0, remember },
    actions: { unsubClaimOf: () => "sends", unsubscribeIdsOf: () => ["held"], decide },
  };
  const m = mount(createElement(SenderDetail, { seg: "waiting", routeKey: row.routeKey, onClose: close }));
  mounted.push(m);
  expect(m.el.textContent).toContain(Copy.decideUnsub("sends", row.address, false));
  const label = Copy.decideAria(destDone(dest), false);
  const button = [...m.el.querySelectorAll<HTMLElement>('[data-role="button"]')]
    .find((node) => node.dataset.label === label);
  expect(button).toBeDefined();
  act(() => button?.click());

  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(row, dest, false, waiting, ["held"]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(shim.alert).not.toHaveBeenCalled();
  expect(remember).not.toHaveBeenCalled();
});


it.each([
  ["ohbox", false], ["receipts", true], ["screened", false], ["spam", true],
] as const)("files to %s from the heading menu (mark read: %s)", (dest, read) => {
  shim.paper = true;
  shim.window = { width: 390, height: 844 };
  const row = {
    routeKey: "sender", scope: "sender", name: "A sender", address: "sender@example.invalid",
    held: [], reached: 0, firstContact: true,
  };
  const waiting = [row];
  const decide = vi.fn();
  shim.world = {
    worldKey: "account", screener: { waiting }, mailboxes: { organizer: null, known: true },
    actions: { unsubClaimOf: () => "sends", unsubscribeIdsOf: () => ["held"], decide },
  };
  const m = mount(createElement(SenderDetail, { seg: "waiting", routeKey: row.routeKey }));
  mounted.push(m);
  const trigger = m.el.querySelector<HTMLElement>(`[data-label="Choose where this sender's mail goes"]`)!;
  expect(trigger?.textContent).toContain("a place");
  const heading = trigger.closest('[data-role="header"]');
  expect(heading?.textContent).toContain(row.name);
  expect(heading?.textContent).toContain("goes to");
  expect(m.el.querySelector('[role="dialog"]')).toBeNull();
  expect(m.el.textContent).toContain(Copy.decideUnsub("sends", row.address, false));
  act(() => trigger.click());
  expect([...m.el.querySelectorAll('[role="dialog"] button')].map((node) => node.textContent)).toEqual([
    ...DESTINATIONS.map((place) => Copy.decideAria(destLabel(place), false)),
    ...DESTINATIONS.map((place) => Copy.decideReadAria(destDone(place))),
  ]);
  const label = read ? Copy.decideReadAria(destDone(dest)) : Copy.decideAria(destLabel(dest), false);
  const button = m.el.querySelector<HTMLElement>(`[role="dialog"] [data-label="${label}"]`)!;
  expect(button).not.toBeNull();
  act(() => button.click());
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(row, dest, read, waiting, ["held"]);
});

it("chooses the decision scope next to the sender address before filing", () => {
  shim.paper = true;
  shim.window = { width: 390, height: 844 };
  const row = {
    routeKey: "sender", scope: "sender", name: "A sender", address: "sender@example.invalid",
    held: [], reached: 0, firstContact: true,
  };
  const setScope = vi.fn();
  const decide = vi.fn();
  shim.world = {
    worldKey: "account",
    screener: { waiting: [row] },
    mailboxes: { organizer: null, known: true },
    actions: { unsubClaimOf: () => "none", unsubscribeIdsOf: () => [], setScope, decide },
  };
  const view = mount(createElement(SenderDetail, { seg: "waiting", routeKey: row.routeKey }));
  mounted.push(view);
  const trigger = view.el.querySelector<HTMLElement>('[data-label="Decision scope"]')!;
  expect(trigger?.textContent).toContain(Copy.scopeSender);
  expect(trigger.parentElement?.parentElement?.textContent).toContain(row.address);
  expect(view.el.querySelector('[role="dialog"]')).toBeNull();
  act(() => trigger.click());
  const domain = [...view.el.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent === "Whole domain");
  expect(domain).toBeDefined();
  act(() => domain?.click());
  expect(setScope).toHaveBeenCalledWith(row, "domain");
  expect(view.el.querySelector('[role="dialog"]')).toBeNull();
  expect(decide).not.toHaveBeenCalled();
});


it.each(["ohbox", "reads", "receipts"] as const)("files to %s from the fixed footer alongside the fixed heading", (dest) => {
  shim.paper = true;
  shim.window = { width: 390, height: 844 };
  const row = {
    routeKey: "sender", scope: "sender", name: "A sender", address: "sender@example.invalid",
    held: [], reached: 0, firstContact: true,
  };
  const waiting = [row];
  const decide = vi.fn();
  shim.world = {
    worldKey: "account", screener: { waiting }, mailboxes: { organizer: null, known: true },
    actions: { unsubClaimOf: () => "sends", unsubscribeIdsOf: () => ["held"], decide },
  };
  const view = mount(createElement(SenderDetail, { seg: "waiting", routeKey: row.routeKey }));
  mounted.push(view);
  const scroll = view.el.querySelector('[data-rn="ScrollView"]')!;
  const heading = view.el.querySelector('[data-role="header"]')!;
  const scope = view.el.querySelector('[data-label="Decision scope"]')!;
  const direct = view.el.querySelector<HTMLElement>(`[data-label="${Copy.decideAria(destDone(dest), false)}"]`)!;
  expect(scroll.textContent).toContain(Copy.heldCaption(0));
  expect(heading).not.toBeNull();
  expect(scope).not.toBeNull();
  expect(direct).not.toBeNull();
  expect(scroll.contains(heading)).toBe(false);
  expect(scroll.contains(scope)).toBe(false);
  expect(scroll.compareDocumentPosition(direct) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(scroll.contains(direct)).toBe(false);
  expect(view.el.querySelector('[role="dialog"]')).toBeNull();
  act(() => direct.click());
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(row, dest, false, waiting, ["held"]);
});
