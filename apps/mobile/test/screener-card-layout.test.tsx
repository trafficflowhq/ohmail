/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ScreenerRow } from "../src/state/world";
import { mount } from "./_rendered-dom";

const scene = vi.hoisted(() => ({ open: vi.fn(), row: null as ScreenerRow | null }));
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}), useFocusEffect: () => undefined }));
vi.mock("../src/state/world", () => ({
  useEngineQueuesAsk: () => () => undefined,
  useWorld: () => ({
    screener: { waiting: [scene.row], screened: [scene.row], spam: [scene.row], failedAtGate: [], relayed: [] },
    boot: { settled: true }, mailboxes: { known: false, rows: [] }, actions: { unsubscribeIdsOf: () => [] },
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
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Badge: rnDom.Text, Button: () => null, Empty: () => null, Panel: rnDom.View, Screen: rnDom.View,
    Tail: rnDom.Text, Tap: rnDom.Pressable, TapRow: rnDom.Pressable, Txt: rnDom.Text, ViewHead: () => null,
  };
});
vi.mock("../src/ui/chrome", () => ({ TopBar: () => null }));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: scene.open, close: () => undefined }),
}));
vi.mock("../src/ui/MailList", () => ({
  MailList: ({ groups, head, renderRow }: {
    groups: { rows: ScreenerRow[] }[]; head: ReactNode; renderRow: (row: ScreenerRow) => ReactNode;
  }) => h("div", null, head, renderRow(groups[0]!.rows[0]!)),
}));
vi.mock("../src/ui/Segmented", () => ({
  Segmented: ({ segments, onChange }: {
    segments: { value: string; label: string }[]; onChange: (value: string) => void;
  }) => segments.map(({ value, label }) => h("button", { key: value, onClick: () => onChange(value) }, label)),
}));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/SenderDetail", () => ({ SenderDetail: () => null }));
vi.mock("../src/ui/ImpersonationNotice", () => ({ ImpersonationNotice: () => null }));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));

import Screener from "../app/(tabs)/screener";
import { EN } from "../src/copy.en";

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
});
