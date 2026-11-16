/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameNotice } from "../../src/frame/contract.js";
import { NoticeHost } from "../../src/frame/NoticeHost.js";
import { createNoticeStore } from "../../src/frame/notice-store.js";
import { TextProvider } from "../../src/text/index.js";
import { FRAME_WORDS } from "../support/frame-words.js";

afterEach(cleanup);

const offline: FrameNotice = { kind: "offline", title: "Offline" };
const trial: FrameNotice = { kind: "trial", title: "Trial ends Wed 18 Nov" };
const update: FrameNotice = { kind: "update", title: "1.0.12 ready", hot: true };

function slot(locale: "en" | "de" = "en") {
  const store = createNoticeStore();
  render(
    <TextProvider locale={locale} messages={FRAME_WORDS[locale]} timeZone="Europe/Zurich">
      <NoticeHost store={store} place="rail" />
    </TextProvider>,
  );
  return store;
}
const shown = () => screen.getAllByRole("status").map((el) => el.textContent);

describe("the one notice slot", () => {
  it("of two notices shows the one the order puts first, and the other behind one line", () => {
    const store = slot();
    act(() => store.post("billing", [trial]));
    act(() => store.post("connection", [offline]));
    expect(shown()).toEqual(["Offline"]);
    expect(screen.getByRole("button", { name: "1 more notice" }).textContent).toContain("1 more");
  });

  it("brings the one pressed in the list to the front, and keeps the order once it is gone", () => {
    const store = slot();
    act(() => store.post("connection", [offline]));
    act(() => store.post("billing", [trial, update]));
    fireEvent.click(screen.getByRole("button", { name: "2 more notices" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["Trial ends Wed 18 Nov", "1.0.12 ready"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Trial ends/ }));
    expect(shown()).toEqual(["Trial ends Wed 18 Nov"]);

    act(() => store.post("billing", [update]));
    expect(shown()).toEqual(["Offline"]);
    act(() => store.post("billing", [trial, update]));
    expect(shown()).toEqual(["Offline"]);
  });

  it("stands empty when nothing is true, and a feed that posts nothing takes its notices away", () => {
    const store = slot();
    act(() => store.post("connection", [offline]));
    act(() => store.post("connection", []));
    expect(screen.queryAllByRole("status")).toEqual([]);
  });

  it("presses the feed's latest answer, though the feed posted the same notice again", () => {
    const store = slot();
    const first = vi.fn();
    const latest = vi.fn();
    act(() => store.post("updates", [{ ...update, acts: [{ label: "Restart", onPress: first }] }]));
    act(() => store.post("updates", [{ ...update, acts: [{ label: "Restart", onPress: latest }] }]));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("says its line in German", () => {
    const store = slot("de");
    act(() => store.post("billing", [trial, update]));
    act(() => store.post("connection", [offline]));
    expect(screen.getByRole("button", { name: "2 weitere Hinweise" }).textContent).toContain("2 weitere");
  });
});

describe("a notice before its words have come", () => {
  function pendingSlot(pending: boolean) {
    const store = createNoticeStore();
    const view = (p: boolean) => (
      <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich" pending={p}>
        <NoticeHost store={store} place="rail" />
      </TextProvider>
    );
    const { rerender } = render(view(pending));
    return { store, landed: () => rerender(view(false)) };
  }

  it("waits while the catalogue is on its way, and is drawn with its words: never an empty box", () => {
    const { store, landed } = pendingSlot(true);
    act(() => store.post("connection", [{ kind: "offline", title: "" }]));
    expect(screen.queryAllByRole("status")).toEqual([]);
    act(() => store.post("billing", [trial]));
    expect(shown()).toEqual(["Trial ends Wed 18 Nov"]);
    expect(screen.queryByRole("button", { name: /more notice/ })).toBeNull();
    act(() => store.post("connection", [offline]));
    landed();
    expect(shown()).toEqual(["Offline"]);
  });
});
