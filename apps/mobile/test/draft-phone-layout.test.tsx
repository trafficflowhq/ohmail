/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { mount, styleOf } from "./_rendered-dom";
import type { WorldDraft } from "../src/state/world";

const scene = vi.hoisted(() => ({ open: vi.fn(), draft: null as WorldDraft | null }));
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: true, scheme: "light",
    c: new Proxy({}, { get: () => "#334455" }),
    radius: new Proxy({}, { get: () => 20 }),
  }),
}));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({ boot: { settled: true }, drafts: [scene.draft], scheduled: [] }),
}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Panel: rnDom.View, Screen: rnDom.View, Scroller: rnDom.ScrollView, Section: rnDom.Text,
    TapRow: rnDom.Pressable, Txt: rnDom.Text, ViewHead: rnDom.Text, Rule: () => null,
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null, TopBar: () => null }));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => null }));
vi.mock("../src/ui/MailPlaceDock", () => ({ MailPlaceDock: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: scene.open, close: vi.fn() }),
}));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/DraftReader", () => ({ DraftReader: () => null }));
vi.mock("../app/scheduled", () => ({ ScheduledRow: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import DraftsScreen from "../app/drafts/index";
import { Copy } from "../src/copy";

it("places the mailbox avatar beside the recipient, time, subject and preview of a draft", () => {
  scene.draft = {
    id: "letter", subject: "Workshop plans", to: "Ada", preview: "Here is the plan.", when: "09:00",
    state: "open", heldSays: null, bodyKnown: true, body: "Here is the plan.", repliesHere: false,
    inReplyToMessageId: null, failure: null, filesNotKept: null, edit: null, waiting: null,
    mailbox: { name: "Office", address: "office@example.test" },
  };
  const view = mount(h(DraftsScreen));
  try {
    const row = view.el.querySelector<HTMLElement>('[data-role="button"]')!;
    expect(styleOf(row)).toMatchObject({ flexDirection: "row" });
    const avatar = row.querySelector('[data-testid="mailbox-avatar-badge"]');
    expect(avatar?.textContent).toBe("O");
    expect(avatar?.parentElement?.nextElementSibling?.textContent).toBe(
      Copy.draftToPerson("Ada") + "09:00Workshop plansHere is the plan.",
    );
    act(() => row.click());
    expect(scene.open).toHaveBeenCalledWith("letter");
  } finally {
    view.unmount();
  }
});
