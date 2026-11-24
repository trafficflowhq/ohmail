/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameNotice } from "../../src/frame/contract.js";
import type { SendLineItem } from "@ohmail/app-logic/writing/mail-send";
import { sendNotices } from "../../src/mail/ground/send-notices.js";
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
    ).toEqual(["Trial ends Wed 18 Nov", "1.0.12 ready", "Show fewer"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Trial ends/ }));
    expect(shown()).toEqual(["Trial ends Wed 18 Nov"]);

    act(() => store.post("billing", [update]));
    expect(shown()).toEqual(["Offline"]);
    act(() => store.post("billing", [trial, update]));
    expect(shown()).toEqual(["Offline"]);
  });

  it.each([
    ["en", "1 more notice", "Show fewer"],
    ["de", "1 weiterer Hinweis", "Weniger anzeigen"],
  ] as const)("folds the other notices back in %s", (locale, more, fewer) => {
    const store = slot(locale);
    act(() => store.post("connection", [offline]));
    act(() => store.post("billing", [trial]));
    const trigger = screen.getByRole("button", { name: more, expanded: false });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: trial.title }), { key: "End" });
    const collapse = within(menu).getByRole("menuitem", { name: fewer });
    expect(document.activeElement).toBe(collapse);
    fireEvent.click(collapse);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(shown()).toEqual(["Offline"]);
    expect(document.activeElement).toBe(trigger);
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

  it.each(["notSent", "unsaved"] as const)("keeps a collapsed %s notice until it resolves", (kind) => {
    const store = slot();
    const notice = { kind, title: "Waiting for you", line: "Details about the problem", hot: true } as const;
    act(() => store.post("mail", [notice]));
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(shown()).toEqual([kind === "notSent" ? "Message not sentShow" : "Waiting for youShow"]);
    expect(screen.queryByText(notice.line)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show", expanded: false }));
    expect(screen.getByText(notice.line, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    act(() => store.post("mail", []));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => store.post("mail", [notice]));
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
  });

  it("expands a collapsed send notice when another failure arrives under the same notice", () => {
    const store = slot();
    const failed = (id: string): SendLineItem => ({
      id,
      key: "compose",
      state: "ended",
      to: null,
      subject: null,
      ended: { phase: "failed", reason: "refused" },
      left: { rowId: id, aboutThisCompose: false },
    });
    const old = failed("first");
    const another = failed("second");
    const next = failed("third");
    const post = (...items: SendLineItem[]) => {
      const notices = sendNotices(
        () => "Message not sent",
        items,
        () => {},
        () => {},
      );
      act(() => store.post("mail", notices));
    };
    post(old, another);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    post(old);
    expect(screen.getByRole("button", { name: "Show", expanded: false })).toBeTruthy();

    post(old, next);
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse", expanded: true })).toBeTruthy();
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
