/** @vitest-environment jsdom */
/**
 * TRASH LISTS A DELETE THAT LANDS WHILE IT IS OPEN: the page is read at the open, and the server
 * move of a letter deleted just before often lands after it. The screen reads page one again when
 * a delete lands and puts the new letter on top, without a second visit. Rendered through React
 * DOM with the world and the screen primitives stood in; the landing signal is the real one.
 * A letter restored from the reader pushed over a one-pane list leaves the list underneath too.
 */
import { act, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldTrashRow } from "../src/state/live";
import { Copy } from "../src/copy";

vi.mock("react-native", async () => ({ ...(await import("./_rendered-dom")).rnDom }));
vi.mock("../src/ui/base", () => {
  const box = (p: { children?: ReactNode }) => createElement("div", null, p.children);
  return {
    Screen: box, Scroller: box, TapRow: box, Tail: box, Panel: box,
    Button: (p: { label: string; onPress: () => void }) => createElement("button", { onClick: p.onPress }, p.label),
    Empty: (p: { title: string; hint?: string }) => createElement("span", { "data-empty": "", "data-hint": p.hint }, p.title),
    Txt: (p: { children?: ReactNode }) => createElement("span", null, p.children),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
const route = { id: "", back: vi.fn() };
vi.mock("expo-router", () => ({
  router: { canGoBack: () => true, back: () => route.back() },
  useLocalSearchParams: () => ({ id: route.id }),
}));
vi.mock("../src/ui/MailRow", () => ({
  MailRow: (p: { m: { id: string } }) => createElement("div", { "data-row": p.m.id }),
}));
vi.mock("../src/ui/MailList", () => ({
  MailList: (p: {
    groups: { rows: WorldTrashRow[] }[]; renderRow: (r: WorldTrashRow) => ReactNode; empty: ReactNode;
  }) => {
    const rows = p.groups.flatMap((g) => g.rows);
    return createElement("div", null, rows.length === 0 ? p.empty : rows.map((r) => createElement("div", { key: r.mail.id }, p.renderRow(r))));
  },
}));
const pane = { open: null as string | null };
vi.mock("../src/ui/list-detail", () => ({
  useListDetail: () => ({ open: pane.open, openRow: () => undefined, close: () => undefined }),
  ListDetail: (p: { list: ReactNode; open: string | null; renderDetail: (id: string, ctx: { onClose: () => void }) => ReactNode }) =>
    createElement("div", null, p.list, p.open ? p.renderDetail(p.open, { onClose: () => undefined }) : null),
}));

const row = (id: string): WorldTrashRow => ({
  mail: { id, place: "ohbox", from: { name: "Ann", address: "" }, subject: id, time: "", body: "", snippet: "", unread: false, earlier: [] },
  deletedWhen: null,
  restoreLabel: "Ohbox",
} as unknown as WorldTrashRow);

const pages: { items: WorldTrashRow[] }[] = [];
const world = {
  trash: { available: true },
  actions: {
    trashList: vi.fn(async (_cursor: string | null) => ({ state: "ready" as const, items: pages.shift()?.items ?? [], nextCursor: null })),
    trashRestore: vi.fn(async (_id: string) => true),
  },
};
vi.mock("../src/state/world", () => ({ useWorld: () => world }));

const { mount } = await import("./_rendered-dom");
const { noteTrashLanded } = await import("../src/state/trash-hold");
const { default: TrashScreen } = await import("../app/trash/index");
const { default: TrashMessageScreen } = await import("../app/trash/[id]");

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const listed = (el: HTMLElement) => [...el.querySelectorAll("[data-row]")].map((n) => n.getAttribute("data-row"));

afterEach(() => { pages.length = 0; pane.open = null; vi.clearAllMocks(); });

describe("a letter deleted just before Trash opened", () => {
  it("is listed on top when its delete lands, in the same visit", async () => {
    pages.push({ items: [row("old")] }, { items: [row("just-deleted"), row("old")] });
    const s = mount(createElement(TrashScreen));
    await settle();
    expect(listed(s.el)).toEqual(["old"]);
    await act(async () => { noteTrashLanded(); });
    await settle();
    expect(listed(s.el)).toEqual(["just-deleted", "old"]);
    expect(world.actions.trashList).toHaveBeenLastCalledWith(null);
    s.unmount();
  });

  it("an empty Trash stops saying it is empty once the delete lands", async () => {
    pages.push({ items: [] }, { items: [row("just-deleted")] });
    const s = mount(createElement(TrashScreen));
    await settle();
    expect(listed(s.el)).toEqual([]);
    await act(async () => { noteTrashLanded(); });
    await settle();
    expect(listed(s.el)).toEqual(["just-deleted"]);
    expect(s.el.querySelector("[data-empty]")).toBeNull();
    s.unmount();
  });
});

describe("the empty Trash says what it holds", () => {
  it.each([[false, Copy.trashEmptyHint], [true, Copy.trashEmptyHintStandalone]])("standalone %s", async (standalone, hint) => {
    Object.assign(world, { standalone });
    pages.push({ items: [] });
    const s = mount(createElement(TrashScreen));
    await settle();
    expect(s.el.querySelector("[data-empty]")!.getAttribute("data-hint")).toBe(hint);
    s.unmount();
    Object.assign(world, { standalone: false });
  });
});

describe("a letter restored from the reader pushed over a one-pane Trash", () => {
  const restoreFromPushed = async (id: string) => {
    route.id = id;
    const d = mount(createElement(TrashMessageScreen));
    await act(async () => { d.el.querySelector("button")!.click(); });
    await settle();
    expect(route.back).toHaveBeenCalled();
    d.unmount();
  };

  it("is gone from the list underneath after Back", async () => {
    pages.push({ items: [row("restored"), row("old")] });
    const s = mount(createElement(TrashScreen));
    await settle();
    await restoreFromPushed("restored");
    expect(world.actions.trashRestore).toHaveBeenCalledWith("restored");
    expect(listed(s.el)).toEqual(["old"]);
    s.unmount();
  });

  it("on two panes, the restore from the paired reader drops the row too", async () => {
    pages.push({ items: [row("paired"), row("old")] });
    pane.open = "paired";
    const s = mount(createElement(TrashScreen));
    await settle();
    await act(async () => { s.el.querySelector("button")!.click(); });
    await settle();
    expect(listed(s.el)).toEqual(["old"]);
    s.unmount();
  });

  it("is listed again when it is deleted again in the same visit", async () => {
    pages.push({ items: [row("again"), row("old")] }, { items: [row("again"), row("old")] });
    const s = mount(createElement(TrashScreen));
    await settle();
    await restoreFromPushed("again");
    expect(listed(s.el)).toEqual(["old"]);
    await act(async () => { noteTrashLanded(); });
    await settle();
    expect(listed(s.el)).toEqual(["again", "old"]);
    s.unmount();
  });
});
