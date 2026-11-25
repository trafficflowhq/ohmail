/** @vitest-environment jsdom */
import { createElement as h, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ id: "projects" }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ mail: true, c: { tag: new Proxy({}, { get: () => ({ ink: "#334455" }) }) } }),
}));
vi.mock("../src/theme/mail", () => ({ MailAppearance: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    boot: { settled: true },
    tags: [{ id: "projects", name: "Projects", hue: "blue" }],
    tagged: { items: () => ({ rows: [{ id: "letter" }], total: 1 }) },
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Screen: rnDom.View, Txt: rnDom.Text, TagDot: () => null,
    ViewHead: ({ title, meta, leading }: { title: string; meta: string; leading?: ReactNode }) =>
      h("header", null, leading, h("h1", null, title), h("span", null, meta)),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => null }));
vi.mock("../src/ui/MailPlaceDock", () => ({
  MailPlaceDock: ({ children }: { children: ReactNode }) => h("div", { "data-mail-dock": "" }, children),
}));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: vi.fn(), close: vi.fn() }),
}));
vi.mock("../src/ui/MailList", () => ({
  MailList: ({ head, groups }: { head: ReactNode; groups: { rows: { id: string }[] }[] }) =>
    h("main", null, head, groups[0]?.rows.map((row) => h("article", { key: row.id }, row.id))),
}));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: () => null }));
vi.mock("../src/ui/MailRow", () => ({ MailRow: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import TagScreen from "../app/tag/[id]";
import { Copy } from "../src/copy";

it("puts the tag heading and count before its rows and keeps one place dock", () => {
  const view = mount(h(TagScreen));
  try {
    expect(view.el.querySelector("h1")?.textContent).toBe("Projects");
    expect(view.el.querySelector("header")?.textContent).toContain(Copy.tagMeta(1));
    expect(view.el.querySelector("[data-mail-dock] article")?.textContent).toBe("letter");
    view.render(h(TagScreen, { inPane: true, id: "projects" }));
    expect(view.el.querySelector("h1")?.textContent).toBe("Projects");
    expect(view.el.querySelector("[data-mail-dock]")).toBeNull();
  } finally {
    view.unmount();
  }
});
