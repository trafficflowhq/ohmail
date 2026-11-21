/** @vitest-environment jsdom */
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { Dialog } from "@ohmail/ui/base";
import { afterEach, expect, it, vi } from "vitest";
import { fragmentAddress } from "@ohmail/app/host/browser";
import { BridgeHost } from "../src/shell/bridge-host";
import { ASK_DEADLINE_MS } from "../src/shell/bridge-kinds";
import type { HttpDoor } from "../src/shell/http-door";
import { phoneSignals } from "../web/src/signals";
import { createBridge, type Bridge } from "../web/src/bridge";

afterEach(() => vi.useRealTimers());

function phone(deliver?: (text: string) => void) {
  const sent: { type: string; askId: number; what: string }[] = [];
  const host = new BridgeHost({
    post: (_, raw) => { sent.push(JSON.parse(raw)); deliver?.(raw); }, config: () => null, http: {} as HttpDoor,
    act: async () => ({}), openHeld: async () => false, ready() {}, place() {}, note() {},
    oldCopy: { page: async () => ({ refused: "notReady" }), done: async () => ({ refused: "notReady" }) },
  });
  host.begin("first");
  let serial = 0;
  const reply = (askId: number, took: boolean | "held" | "prepare" | "discard", epoch = "first") => host.receive({
    epoch, origin: "https://appassets.androidplatform.net", mainFrame: true,
    data: JSON.stringify({ epoch, kind: "answer", id: ++serial, askId, what: "back", took }),
  });
  const place = (fragment: string) => host.receive({
    epoch: "first", origin: "https://appassets.androidplatform.net", mainFrame: true,
    data: JSON.stringify({ epoch: "first", kind: "place", id: ++serial, fragment }),
  });
  const deliverFromPage = (data: string) => host.receive({
    epoch: "first", origin: "https://appassets.androidplatform.net", mainFrame: true, data,
  });
  const exit = vi.fn();
  const confirm = vi.fn();
  return { host, reply, place, exit, confirm, sent, deliverFromPage, press() {
    host.physicalBack(exit, confirm);
    return sent.filter((event) => event.type === "ask").at(-1)!.askId;
  } };
}

it("a physical Back held by an unsaved page outlives the reply deadline and leaves once only after Discard", async () => {
  vi.useFakeTimers();
  const p = phone();
  const first = p.press();
  p.reply(first, "held");
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS * 3);
  expect(p.exit).not.toHaveBeenCalled();
  expect(p.confirm).not.toHaveBeenCalled();
  p.reply(first, "prepare");
  p.reply(first, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  p.reply(first, "discard");
  p.reply(first, "discard");
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).toHaveBeenCalledTimes(1);
});

it("a second physical press, a new page or leaving the foreground retires the previous choice", async () => {
  vi.useFakeTimers();
  const p = phone();
  const first = p.press();
  p.reply(first, "held");
  await vi.advanceTimersByTimeAsync(1);
  const second = p.press();
  p.reply(first, false);
  p.reply(second, "held");
  await vi.advanceTimersByTimeAsync(1);
  p.host.cancelPhysicalBack();
  p.reply(second, false);
  const third = p.press();
  p.reply(third, "held");
  p.host.begin("second");
  p.reply(third, false);
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS * 2);
  expect(p.exit).not.toHaveBeenCalled();
  expect(p.confirm).not.toHaveBeenCalled();
});

it("an unanswered physical press asks natively before any exit, and a stale native confirmation cannot leave", async () => {
  vi.useFakeTimers();
  const p = phone();
  p.press();
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS);
  expect(p.exit).not.toHaveBeenCalled();
  const old = p.confirm.mock.calls[0]![0];
  p.press();
  old();
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS);
  expect(p.exit).not.toHaveBeenCalled();
  p.confirm.mock.calls[1]![0]();
  expect(p.exit).toHaveBeenCalledTimes(1);
});

it("takes Back inside an overlay first, then offers the dirty pane's actual Keep and Discard", async () => {
  const address = fragmentAddress(window);
  address.write("#/settings/signatures", "replace");
  const ask = vi.fn();
  const release = address.holdLeave(ask, address.read());
  const request = vi.fn().mockResolvedValue({ accepted: true });
  let incoming!: (event: object) => void;
  const bridge = { request, on: (listen: typeof incoming) => { incoming = listen; } } as unknown as Bridge;
  const signal = phoneSignals(bridge, {
    posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboard: { height: 0 }, online: true,
  }, () => 0, address);
  const close = signal.back.subscribe(() => true);
  const back = (askId: number) => incoming({ type: "ask", askId, what: "back" });
  try {
    back(1);
    expect(ask).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("answer", { askId: 1, what: "back", took: true });
    close();
    back(2);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("answer", { askId: 2, what: "back", took: "held" });
    incoming({ type: "backEnded", askId: 2 });
    back(3);
    ask.mock.calls[0]![0]();
    expect(request).not.toHaveBeenCalledWith("answer", { askId: 2, what: "back", took: false });
    const discarded = vi.fn();
    ask.mock.calls[1]![0](discarded);
    await vi.waitFor(() => expect(discarded).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("answer", { askId: 3, what: "back", took: false });
    back(4);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("answer", { askId: 4, what: "back", took: "discard" }));
    expect(request).toHaveBeenCalledWith("answer", { askId: 4, what: "back", took: false });
  } finally { release(); }
});

it("a new place in the same page retires its held hardware Back and its native confirmation", async () => {
  vi.useFakeTimers();
  const p = phone();
  p.place("#/settings/signatures");
  await vi.advanceTimersByTimeAsync(1);
  const held = p.press();
  p.reply(held, "held");
  await vi.advanceTimersByTimeAsync(1);
  p.place("#/history");
  await vi.advanceTimersByTimeAsync(1);
  p.reply(held, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  p.press();
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS);
  const discard = p.confirm.mock.calls[0]![0];
  p.place("#/settings/away");
  await vi.advanceTimersByTimeAsync(1);
  discard();
  expect(p.exit).not.toHaveBeenCalled();
  const same = p.press();
  p.place("#/settings/away");
  p.reply(same, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  p.reply(same, "held");
  p.reply(same, "prepare");
  p.reply(same, false);
  p.reply(same, "discard");
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).toHaveBeenCalledTimes(1);
});

it("hardware Back closes the actual kit dialog before the reader can take it", () => {
  let incoming!: (event: object) => void;
  const request = vi.fn().mockResolvedValue({ accepted: true });
  const bridge = { request, on: (cb: typeof incoming) => { incoming = cb; } } as unknown as Bridge;
  const signal = phoneSignals(bridge, {
    posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboard: { height: 0 }, online: true,
  }, () => 0, fragmentAddress(window));
  const reader = vi.fn(() => true);
  const off = signal.back.subscribe(reader);
  const close = vi.fn();
  const dialog = render(createElement(Dialog, { open: true, title: "Leave this editor?", onClose: close, cancel: { label: "Keep" } }));
  try {
    act(() => incoming({ type: "ask", askId: 1, what: "back" }));
    expect(close).toHaveBeenCalledOnce();
    expect(reader).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("answer", { askId: 1, what: "back", took: true });
    dialog.unmount();
    act(() => incoming({ type: "ask", askId: 2, what: "back" }));
    expect(reader).toHaveBeenCalledOnce();
  } finally { dialog.unmount(); off(); }
});

it("a stale native receipt cannot discard or release a dirty pane", async () => {
  const address = fragmentAddress(window);
  address.write("#/settings/signatures", "replace");
  const ask = vi.fn();
  const release = address.holdLeave(ask, address.read());
  try {
    for (const accepted of [false, true]) {
      const controller = new AbortController();
      let respond!: (accepted: boolean) => void;
      const receipt = new Promise<boolean>((done) => { respond = done; });
      const drop = vi.fn();
      expect(address.heldBefore("", () => receipt, { signal: controller.signal, keep() {} })).toBe(true);
      ask.mock.lastCall![0](drop);
      expect(drop).not.toHaveBeenCalled();
      if (accepted) controller.abort();
      respond(accepted);
      await receipt;
      expect(drop).not.toHaveBeenCalled();
    }
    expect(address.heldBefore("", () => {})).toBe(true);
  } finally { release(); }
});

it("the native leave alert can take focus, and leaving the app still retires it", async () => {
  vi.useFakeTimers();
  const p = phone();
  p.press();
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS);
  p.host.windowBlur();
  p.confirm.mock.calls[0]![0]();
  expect(p.exit).toHaveBeenCalledTimes(1);
  p.press();
  await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS);
  p.host.windowBlur();
  p.host.cancelPhysicalBack();
  p.confirm.mock.calls[1]![0]();
  expect(p.exit).toHaveBeenCalledTimes(1);
});

it("a place queued before page replacement cannot cancel a new Back", async () => {
  vi.useFakeTimers();
  const p = phone();
  p.place("#/history");
  p.host.begin("replacement");
  const id = p.press();
  p.reply(id, "held", "replacement");
  p.reply(id, "prepare", "replacement");
  p.reply(id, false, "replacement");
  p.reply(id, "discard", "replacement");
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).toHaveBeenCalledOnce();
});

it("a held draft exit needs its final choice, and a newer Keep settles it first", async () => {
  vi.useFakeTimers();
  const p = phone();
  const press = p.press();
  p.reply(press, "held");
  p.reply(press, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  p.reply(press, "discard");
  p.reply(press, "prepare");
  p.reply(press, false);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  p.reply(press, true);
  p.reply(press, "discard");
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).not.toHaveBeenCalled();
  const next = p.press();
  p.reply(next, "held");
  p.reply(next, "prepare");
  p.reply(next, false);
  p.reply(next, "discard");
  p.reply(next, "discard");
  await vi.advanceTimersByTimeAsync(1);
  expect(p.exit).toHaveBeenCalledOnce();
});

it("a lost final receipt protects the page until native confirms retirement", async () => {
  const address = fragmentAddress(window);
  address.write("#/settings/signatures", "replace");
  const ask = vi.fn();
  const release = address.holdLeave(ask, address.read());
  let incoming!: (e: object) => void;
  let retire!: () => void;
  const request = vi.fn((_kind: string, a: { took: unknown }) => {
    if (a.took === "discard") return Promise.reject(new Error("deadline"));
    if (a.took === true) return new Promise((done) => { retire = () => done({ accepted: false }); });
    return Promise.resolve({ accepted: true });
  });
  const bridge = { request, on: (handle: typeof incoming) => { incoming = handle; } } as unknown as Bridge;
  phoneSignals(bridge, {
    posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboard: { height: 0 }, online: true,
  }, () => 0, address);
  try {
    incoming({ type: "ask", what: "back", askId: 6 });
    const drop = vi.fn();
    ask.mock.lastCall![0](drop);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("answer", { askId: 6, what: "back", took: true }));
    expect(document.body.hasAttribute("inert")).toBe(true);
    expect(drop).not.toHaveBeenCalled();
    retire();
    await vi.waitFor(() => expect(document.body.hasAttribute("inert")).toBe(false));
    expect(address.heldBefore("", () => {})).toBe(true);
  } finally { release(); document.body.removeAttribute("inert"); }
});

it("a clean Back rechecks the editor after native's delayed reply and waits for the new draft's choice", async () => {
  const address = fragmentAddress(window);
  address.write("#/settings/mailboxes", "replace");
  let fromNative!: (text: string) => void;
  const p = phone((text) => fromNative(text));
  const pending: string[] = [];
  let delayed = true;
  const bridge = createBridge({
    post: (text) => { if (delayed) pending.push(text); else p.deliverFromPage(text); },
    listen: (receive) => { fromNative = receive; return () => {}; },
  }, "first");
  phoneSignals(bridge, {
    posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboard: { height: 0 }, online: true,
  }, () => 0, address);
  p.press();
  expect(pending.length).toBeGreaterThan(0);
  const ask = vi.fn();
  const release = address.holdLeave(ask, address.read());
  try {
    delayed = false;
    for (const message of pending) p.deliverFromPage(message);
    await vi.waitFor(() => expect(p.exit.mock.calls.length + ask.mock.calls.length).toBeGreaterThan(0));
    expect(p.exit).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledOnce();
    const drop = vi.fn();
    ask.mock.lastCall![0](drop);
    await vi.waitFor(() => expect(p.exit).toHaveBeenCalledOnce());
    expect(drop).toHaveBeenCalledOnce();
    expect(document.body.hasAttribute("inert")).toBe(false);
  } finally {
    p.host.cancelPhysicalBack();
    release();
  }
});

it("a clean Back holds input only until native refuses or retires the exit", async () => {
  const address = fragmentAddress(window);
  address.write("#/settings/mailboxes", "replace");
  let incoming!: (event: object) => void;
  let finish!: () => void;
  const request = vi.fn((_kind: string, answer: { took: unknown }) => {
    if (answer.took === "discard") return new Promise((resolve) => { finish = () => resolve({ accepted: false }); });
    return Promise.resolve({ accepted: true });
  });
  const bridge = { request, on: (listen: typeof incoming) => { incoming = listen; } } as unknown as Bridge;
  phoneSignals(bridge, {
    posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboard: { height: 0 }, online: true,
  }, () => 0, address);
  try {
    for (const askId of [1, 2]) {
      incoming({ type: "ask", what: "back", askId });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("answer", { askId, what: "back", took: "discard" }));
      expect(document.body.hasAttribute("inert")).toBe(true);
      if (askId === 2) {
        incoming({ type: "backEnded", askId });
        expect(document.body.hasAttribute("inert")).toBe(false);
      }
      finish();
      await vi.waitFor(() => expect(document.body.hasAttribute("inert")).toBe(false));
    }
  } finally {
    document.body.removeAttribute("inert");
  }
});
