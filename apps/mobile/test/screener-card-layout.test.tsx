/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ScreenerRow } from "../src/state/world";
import type { PhoneMailbox } from "../src/net/mailboxes";
import { mount } from "./_rendered-dom";

const scene = vi.hoisted(() => ({
  open: vi.fn(), decide: vi.fn(), row: null as ScreenerRow | null, compact: false, worldKey: "fixture-account",
  unsubscribe: [] as string[], remember: vi.fn(), claim: "sends" as "sends" | "may_send", advertised: false,
  roster: null as PhoneMailbox[] | null, presses: new Map<string, () => void>(),
}));
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}), useFocusEffect: () => undefined }));
vi.mock("../src/state/world", () => ({
  useEngineQueuesAsk: () => () => undefined,
  useWorld: () => ({
    worldKey: scene.worldKey,
    screener: { waiting: [scene.row], screened: scene.compact ? [] : [scene.row], spam: scene.compact ? [] : [scene.row], failedAtGate: [], relayed: [] },
    boot: { settled: true }, mailboxes: { known: scene.roster !== null, rows: scene.roster ?? [] },
    actions: { decide: scene.decide, unsubClaimOf: () => scene.advertised || scene.unsubscribe.length ? scene.claim : "none", unsubscribeIdsOf: () => scene.unsubscribe },
    screenerConfirmation: { acknowledged: 0, remember: scene.remember },
  }),
}));
vi.mock("../src/engine/organizer-session", () => ({ standaloneHereFor: () => false }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ state: { k: "idle" } }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: true, face: "paper", scheme: "light",
    c: new Proxy({}, { get: () => "white" }), radius: { pill: 999 },
  }),
}));
vi.mock("../src/state/pull", () => ({
  usePullToSync: () => ({ refreshing: false, onRefresh: () => undefined }),
}));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ sizeClass: scene.compact ? "compact" : "expanded" }) }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Badge: rnDom.Text, Button: () => null, Empty: () => null, Panel: rnDom.View, Screen: rnDom.View,
    Tail: rnDom.Text, Tap: rnDom.Pressable, TapRow: rnDom.Pressable, Txt: rnDom.Text,
    ViewHead: ({ title, leading }: { title: string; leading?: ReactNode }) =>
      h("header", null, leading, h("h1", null, title)),
  };
});
vi.mock("../src/ui/chrome", () => ({ TopBar: () => null }));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: scene.open, close: () => undefined }),
}));
vi.mock("../src/ui/MailList", () => ({
  MailList: ({ groups, head, sheetHead, renderRow, fitSurface }: {
    groups: { rows: ScreenerRow[] }[]; head: ReactNode; sheetHead?: ReactNode;
    renderRow: (row: ScreenerRow) => ReactNode; fitSurface?: boolean;
  }) => h("div", { "data-fit-surface": fitSurface ? "yes" : undefined },
    head, h("div", { "data-sheet-tools": "" }, sheetHead), groups[0]!.rows.map(renderRow)),
}));
vi.mock("../src/ui/Segmented", () => ({
  Segmented: ({ segments, onChange }: {
    segments: { value: string; label: string; count?: number }[]; onChange: (value: string) => void;
  }) => segments.map(({ value, label, count }) => h("button", { key: value, "data-count": count, onClick: () => onChange(value) }, label)),
}));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, label, children, onClose, confirmation }: {
    open: boolean; label: string; children: ReactNode; onClose: () => void;
    confirmation?: { note: string; action: { label: string; onPress: () => void } };
  }) => {
    if (!open) return null;
    if (confirmation) scene.presses.set(confirmation.action.label, confirmation.action.onPress);
    return h("section", { "aria-label": label, "data-confirmation": confirmation ? "center" : undefined },
      confirmation?.note, children,
      confirmation ? h("button", { onClick: confirmation.action.onPress }, confirmation.action.label) : null,
      confirmation ? h("button", { onClick: onClose }, "Cancel") : null);
  },
  SheetRow: ({ label, onPress, detail }: { label: string; onPress: () => void; detail?: string }) => {
    scene.presses.set(label, onPress);
    return h("button", { onClick: onPress, "data-detail": detail }, label);
  },
}));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/SenderDetail", () => ({ SenderDetail: () => null }));
vi.mock("../src/ui/ImpersonationNotice", () => ({ ImpersonationNotice: () => null }));
vi.mock("../src/ui/MailCalendarSwitch", () => ({
  MailCalendarSwitch: () => h("button", { "aria-label": "Switch to Calendar" }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));

vi.mock("../src/ui/HeadingEnd", () => ({
  HeadingEnd: ({ children, hot, show }: { children: string; hot: boolean; show?: boolean }) =>
    h("span", { "data-attention": hot && show !== false ? "hot" : undefined }, children),
}));

import Screener from "../app/(tabs)/screener";
import { EN } from "../src/copy.en";

const testRow = {
  id: "letter", routeKey: "letters@sender.example", name: "Workshop", address: "letters@sender.example",
  initial: "W", time: "10:00", newestSubject: "Workshop registration", newestPreview: "There is space.",
  mailboxLabel: "Workshop administration", mailbox: { name: "Workshop administration", address: "office@example.test" },
  mailboxId: "workshop-mailbox", dull: false, scope: "sender", ai: null, reached: 0,
  held: [{ id: "letter", subject: "Workshop registration", body: "There is space.", time: "10:00", seen: false }],
  screenedOn: "10:00", detection: "", gatePhysical: true,
} as const satisfies Omit<ScreenerRow, "held"> & { held: readonly ScreenerRow["held"][number][]; mailboxId: string };

function compactRow(overrides: Partial<ScreenerRow> & { mailboxId?: string } = {}): ScreenerRow {
  return { ...testRow, held: [...testRow.held], ...overrides };
}

const readerMailbox: PhoneMailbox = {
  id: "workshop-mailbox", address: "office@example.test", status: "connected",
  organizerRole: "reader", organizerState: "held", organizedBy: { kind: "local", name: "Workshop desktop" },
  organizedByThisInstall: false, organizeConsentedAt: "2026-09-01", junkFolder: null, sentFolder: null,
  smtpMaxSizeBytes: null, firstSyncStopFolder: null,
};

const remoteReader = (accepts: boolean) => ({ ...readerMailbox, organizerAcceptsRequests: accepts });
const chooser = (view: ReturnType<typeof mount>) => view.el.querySelector<HTMLElement>('[data-label="Choose a place"]');
const placeMenu = (view: ReturnType<typeof mount>) => view.el.querySelector('[aria-label="Choose a place"]');

describe("native Screener mail cards", () => {
  it.each([EN.segWaiting, EN.segScreened, EN.segSpam])("opens a sender from a complete card in %s", (tab) => {
    const address = "letters@very-long-sender-domain.example";
    const subject = "Workshop registration";
    const preview = "Here is a place for the next class.";
    const mailboxLabel = "Workshop administration";
    scene.open.mockReset();
    scene.row = {
      id: "letter", routeKey: address, name: "Workshop", address, initial: "W", time: "10:00",
      newestSubject: subject, newestPreview: preview, mailboxLabel, mailbox: { name: mailboxLabel, address: "office@example.test" }, dull: false, scope: "sender", ai: null, reached: 0,
      held: [{ id: "letter", subject, body: preview, time: "10:00", seen: false }],
      screenedOn: "10:00", detection: "", gatePhysical: true,
    };
    const view = mount(h(Screener));
    try {
      const selected = Array.from(view.el.querySelectorAll("button")).find((button) => button.textContent === tab)!;
      act(() => selected.click());
      const card = view.el.querySelector<HTMLElement>(`[data-role="button"][data-label*="${address}"]`)!;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain(subject);
      expect(card.textContent).toContain(preview);
      expect(card.textContent).toContain("10:00");
      expect(card.textContent).toContain(mailboxLabel);
      expect(card.querySelector("[data-testid='mailbox-avatar-badge']")?.textContent).toBe("W");
      expect(card.getAttribute("data-label")).toContain(EN.deliveredTo(mailboxLabel));
      act(() => card.click());
      expect(scene.open).toHaveBeenCalledOnce();
      expect(scene.open).toHaveBeenCalledWith(address);
    } finally {
      view.unmount();
    }
  });

  it("starts the compact Paper Screener at its title and keeps the switch in the wide header", () => {
    scene.compact = true;
    scene.row = compactRow();
    const view = mount(h(Screener));
    try {
      const header = () => view.el.querySelector("header")!;
      expect(header().querySelector("h1")?.textContent).toBe(EN.screener);
      expect(header().querySelector('[aria-label="Switch to Calendar"]')).toBeNull();
      scene.compact = false;
      view.render(h(Screener));
      expect(header().querySelector('[aria-label="Switch to Calendar"]')).not.toBeNull();
    } finally {
      view.unmount();
      scene.compact = false;
    }
  });

  it("marks All as active and fits the phone sheet around the waiting rows", () => {
    scene.compact = true;
    scene.row = compactRow();
    const view = mount(h(Screener));
    try {
      expect.soft(view.el.querySelector("[data-fit-surface]")).not.toBeNull();
      expect(view.el.querySelector("[data-sheet-tools] [data-attention=hot]")?.textContent).toBe(EN.searchAll);
    } finally {
      view.unmount();
      scene.compact = false;
    }
  });

  it("keeps the sender address and a separate place chooser on the phone row", () => {
    const { address, mailboxLabel } = testRow;
    scene.row = compactRow();
    scene.compact = true;
    scene.open.mockClear();
    scene.decide.mockClear();
    const view = mount(h(Screener));
    const choice = () => chooser(view);
    const menu = () => placeMenu(view);
    const enter = () => act(() => { choice()!.click(); });
    try {
      const card = view.el.querySelector<HTMLElement>(`[data-role="button"][data-label*="${address}"]`)!;
      expect(card.textContent).toContain(address);
      expect(card.getAttribute("data-label")).toContain(EN.deliveredTo(mailboxLabel));
      expect.soft(card.textContent).not.toContain(mailboxLabel);
      expect.soft(card.querySelector("[data-testid='mailbox-avatar-badge']")).toBeNull();
      expect.soft(view.el.querySelectorAll('button[data-count="0"]')).toHaveLength(0);
      expect(choice()?.textContent).toBe("Choose");
      enter();
      expect(scene.open).not.toHaveBeenCalled();
      expect(scene.decide).not.toHaveBeenCalled();
      const news = [...menu()!.querySelectorAll("button")].find((button) => button.textContent === EN.placeReads)!;
      act(() => { news.click(); });
      expect(scene.decide).toHaveBeenCalledWith(scene.row, "reads", false, [scene.row], []);
      expect(menu()).toBeNull();

      scene.unsubscribe = ["letter"];
      enter();
      const spam = [...menu()!.querySelectorAll("button")].find((button) => button.textContent === EN.placeSpam)!;
      act(() => { spam.click(); });
      expect(scene.decide).toHaveBeenCalledTimes(1);
      const question = () => view.el.querySelector('[aria-label="Spam and unsubscribe"]');
      expect(question()?.getAttribute("data-confirmation")).toBe("center");
      expect(question()?.textContent).toContain("Once sent, it cannot be undone.");
      expect(question()?.textContent).toContain("one-click unsubscribe");
      const cancel = [...(question()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Cancel")!;
      act(() => { cancel.click(); });
      expect(question()).toBeNull();
      expect(scene.decide).toHaveBeenCalledTimes(1);
      expect(scene.remember).not.toHaveBeenCalled();
      enter();
      act(() => { scene.presses.get(EN.placeSpam)!(); });
      const confirm = [...(question()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Spam and unsubscribe")!;
      scene.unsubscribe = ["letter", "newer-letter"];
      act(() => { confirm.click(); });
      expect(scene.remember).toHaveBeenCalledOnce();
      expect(scene.decide).toHaveBeenLastCalledWith(scene.row, "spam", false, [scene.row], ["letter"]);
      scene.unsubscribe = [];

      enter();
      const stale = scene.presses.get(EN.placeReads)!;
      scene.worldKey = "another-fixture-account";
      view.render(h(Screener));
      act(() => { stale(); });
      expect(menu()).toBeNull();
      expect(scene.decide).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      scene.compact = false;
      scene.worldKey = "fixture-account";
      scene.unsubscribe = [];
      scene.remember.mockClear();
    }
  });

  it("accepts a suggestion in one press and keeps a separate chooser", () => {
    scene.compact = true;
    scene.row = compactRow({ ai: { dest: "reads", confidence: 0.91, rationale: "The sender publishes issues." } });
    scene.decide.mockClear();
    const view = mount(h(Screener));
    try {
      expect(chooser(view)).not.toBeNull();
      const accept = view.el.querySelector<HTMLElement>(`[data-label="${EN.placeReads}"]`)!;
      expect(accept?.textContent).toBe(EN.placeReads);
      act(() => { accept.click(); });
      expect(scene.decide).toHaveBeenCalledWith(scene.row, "reads", false, [scene.row], []);
    } finally {
      view.unmount();
      scene.compact = false;
    }
  });

  it("offers no phone decision when the live organizer cannot receive it, even from an already open menu", () => {
    scene.compact = true;
    scene.row = compactRow();
    scene.roster = [remoteReader(false)];
    scene.decide.mockClear();
    const view = mount(h(Screener));
    try {
      expect(chooser(view)).toBeNull();
      scene.roster = [remoteReader(true)];
      view.render(h(Screener));
      expect(chooser(view)?.textContent).toBe("Choose");
      act(() => { chooser(view)!.click(); });
      const oldPress = scene.presses.get(EN.placeReads)!;
      scene.roster = [remoteReader(false)];
      view.render(h(Screener));
      expect(placeMenu(view)).toBeNull();
      act(() => { oldPress(); });
      expect(scene.decide).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      scene.compact = false;
      scene.roster = null;
    }
  });

  it.each([
    ["scope widens to the domain", () => compactRow({ scope: "domain" })],
    ["the representative is from a different mailbox", () => compactRow({ mailboxId: "other-mailbox" })],
  ] as const)("closes the open chooser when %s", (_changed, replace) => {
    scene.compact = true;
    scene.row = compactRow();
    scene.decide.mockClear();
    const view = mount(h(Screener));
    try {
      expect(chooser(view)?.textContent).toBe("Choose");
      act(() => { chooser(view)!.click(); });
      const oldPress = scene.presses.get(EN.placeReads)!;
      expect(placeMenu(view)).not.toBeNull();
      scene.row = replace();
      view.render(h(Screener));
      expect(placeMenu(view)).toBeNull();
      act(() => { oldPress(); });
      expect(scene.decide).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      scene.compact = false;
    }
  });

  it("says Continue for a conditional one-click request and performs no action before consent", () => {
    scene.compact = true;
    scene.row = compactRow();
    scene.unsubscribe = ["letter"];
    scene.claim = "may_send";
    scene.decide.mockClear();
    scene.remember.mockClear();
    const view = mount(h(Screener));
    try {
      act(() => { chooser(view)!.click(); });
      act(() => { scene.presses.get(EN.destScreenOut)!(); });
      const question = view.el.querySelector('[aria-label="Screen out and unsubscribe"]');
      expect(question?.getAttribute("data-confirmation")).toBe("center");
      expect(question?.textContent).toContain("if their waiting mail offers one-click unsubscribe");
      expect(question?.textContent).toContain("Continue");
      expect(scene.decide).not.toHaveBeenCalled();
      act(() => { scene.presses.get("Continue")!(); });
      expect(scene.remember).toHaveBeenCalledWith("screenOutUnsubscribe");
      expect(scene.decide).toHaveBeenCalledWith(scene.row, "screened", false, [scene.row], ["letter"]);
    } finally {
      view.unmount();
      scene.compact = false;
      scene.unsubscribe = [];
      scene.claim = "sends";
    }
  });

  it("asks before filing when the menu offers a conditional unsubscribe and the mirror supplies zero candidate letters", () => {
    scene.compact = true;
    scene.row = compactRow();
    scene.claim = "may_send";
    scene.advertised = true;
    scene.unsubscribe = [];
    scene.decide.mockClear();
    scene.remember.mockClear();
    const view = mount(h(Screener));
    try {
      const ask = () => view.el.querySelector('[aria-label="Screen out and unsubscribe"]');
      const enter = () => {
        act(() => { chooser(view)!.click(); });
        const screenOut = [...(placeMenu(view)?.querySelectorAll("button") ?? [])]
          .find((button) => button.textContent === EN.destScreenOut)!;
        expect(screenOut.getAttribute("data-detail")).toBe("+ unsubscribe");
        act(() => { screenOut.click(); });
        expect.soft(scene.decide).not.toHaveBeenCalled();
        expect(ask()?.getAttribute("data-confirmation")).toBe("center");
      };

      enter();
      const cancel = [...(ask()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Cancel")!;
      act(() => { cancel.click(); });
      expect(ask()).toBeNull();
      expect(scene.decide).not.toHaveBeenCalled();
      expect(scene.remember).not.toHaveBeenCalled();

      enter();
      // A body or a new letter can arrive during the question. Its candidate ID was never granted.
      scene.unsubscribe = ["newly-confirmed-letter"];
      act(() => { scene.presses.get("Continue")!(); });
      expect(scene.remember).toHaveBeenCalledWith("screenOutUnsubscribe");
      expect(scene.decide).toHaveBeenCalledOnce();
      expect(scene.decide).toHaveBeenCalledWith(scene.row, "screened", false, [scene.row], []);
      expect(ask()).toBeNull();
    } finally {
      view.unmount();
      scene.compact = false;
      scene.advertised = false;
      scene.claim = "sends";
      scene.unsubscribe = [];
    }
  });

  it("withdraws an unsubscribe confirmation if the opening sender scope widens", () => {
    scene.compact = true;
    scene.row = compactRow();
    scene.unsubscribe = ["letter"];
    scene.decide.mockClear();
    scene.remember.mockClear();
    const view = mount(h(Screener));
    try {
      expect(chooser(view)?.textContent).toBe("Choose");
      act(() => { chooser(view)!.click(); });
      act(() => { scene.presses.get(EN.placeSpam)!(); });
      const oldConfirm = scene.presses.get("Spam and unsubscribe")!;
      expect(view.el.querySelector('[aria-label="Spam and unsubscribe"]')).not.toBeNull();
      scene.row = compactRow({ scope: "domain" });
      view.render(h(Screener));
      act(() => { oldConfirm(); });
      expect(view.el.querySelector('[aria-label="Spam and unsubscribe"]')).toBeNull();
      expect(scene.decide).not.toHaveBeenCalled();
      expect(scene.remember).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      scene.compact = false;
      scene.unsubscribe = [];
    }
  });

});
