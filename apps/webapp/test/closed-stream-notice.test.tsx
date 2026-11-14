/** @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { issue, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream, STREAM_DATE } from "./stream-check-frame.js";

const picture = '<img src="https://images.example.test/cover.png" width="600" height="200">';
const pixel = '<img src="https://images.example.test/open.gif" width="1" height="1">';
const sheet = '<style>@import url("https://images.example.test/style.css");</style>';

it.each([
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const)("%s exposes blocked content notices for cached closed cards without a request", async (route, name, make) => {
  vi.stubGlobal("innerHeight", 2000);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const store = new MemoryMirrorStore();
  await store.load();
  for (const [i, html] of Array.from({ length: 10 }, (_, i) => [i, [pixel, picture, sheet][i % 3]!] as const)) {
    const id = `letter-${i}`;
    const letter = make(id, 20 - i, { body: undefined, amount: route === "receipts" ? "CHF 12.00" : undefined });
    await store.applyChanges([{
      type: "message", op: "create", id, seq: i + 1, updatedAt: letter.updatedAt, entity: letter,
    }]);
    await store.putLocal("message_body", id, { messageId: id, state: "ready", text: "Cached preview", html });
  }
  const fetchBody = vi.fn(async () => null);
  const mutate = vi.fn(async () => ({ changes: [], seq: null }));
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: STREAM_DATE,
      }),
      mutate,
      fetchBody,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    },
  });
  await engine.start();
  const { address, el } = await mountCheckedStream(engine, `#/${route}`);
  const region = within(within(el).getByRole("region", { name: `${name} stream` }));
  expect(region.getAllByRole("heading")).toHaveLength(10);
  const notices = region.getAllByRole("button", { name: /(?:tracker|images|stylesheet) blocked/i });
  expect(notices).toHaveLength(10);
  expect(region.getAllByRole("button", { name: /stylesheet blocked/i })).toHaveLength(3);
  expect(region.getAllByRole("button", { name: /images blocked/i })).toHaveLength(3);
  if (route === "receipts") expect(region.getAllByText("CHF 12.00")).toHaveLength(10);
  expect(region.queryByRole("note")).toBeNull();
  const tracker = region.getAllByRole("button", { name: /tracker blocked/i })[0]!;
  expect(document.getElementById(tracker.getAttribute("aria-describedby")!)?.textContent).toMatch(/tracking pixel/i);
  expect(el.querySelector("iframe, img[src*='images.example.test']")).toBeNull();
  fireEvent.click(tracker);
  expect(screen.getByRole("note").textContent).toMatch(/tracking pixel/i);
  expect(region.queryByRole("button", { name: "Collapse" })).toBeNull();
  expect(address.read()).toBe(`#/${route}`);
  expect(fetchBody).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});

it("a body fetched on approach stays invisible until the person opens the News card", async () => {
  let approach: (() => void) | undefined;
  const target = new Set<Element>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      if (options?.rootMargin === "100% 0px") {
        approach = () => callback([...target].map((element) => ({
          target: element, isIntersecting: true,
        }) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
      }
    }
    observe(element: Element) { target.add(element); }
    unobserve(element: Element) { target.delete(element); }
    disconnect() { target.clear(); }
  });
  const store = new MemoryMirrorStore();
  await store.load();
  const id = "offered";
  const letter = issue(id, 20, { body: undefined, snippet: "The original preview" });
  await store.applyChanges([{
    type: "message", op: "create", id, seq: 1, updatedAt: letter.updatedAt, entity: letter,
  }]);
  const fetchBody = vi.fn(async () => ({
    text: "The full letter",
    loadedRemoteContent: false,
    unsubscribe: "no_header" as const,
    unsubscribeUrl: null,
    html: `<table width="600" cellpadding="0"><tr><td><h1>The full letter</h1>${picture}</td></tr></table>`,
  }));
  const mutate = vi.fn(async () => ({ changes: [], seq: null }));
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: STREAM_DATE,
      }),
      mutate,
      fetchBody,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    },
  });
  await engine.start();
  const { el, address } = await mountCheckedStream(engine, "#/reads");
  const stream = screen.getByRole("region", { name: "News stream" });
  const preview = stream.textContent;
  const row = screen.getByRole("option", { name: /Issue 20/ });
  expect(within(stream).getByText("The original preview")).toBeTruthy();
  expect(approach).toBeDefined();
  await act(async () => approach?.());
  await waitFor(() => expect(engine.read().get("message_body", id)).toMatchObject({ state: "ready" }));
  await act(async () => approach?.());
  expect(fetchBody.mock.calls).toEqual([[id]]);
  expect(stream.textContent).toBe(preview);
  expect(el.querySelector("iframe, img[src*='images.example.test']")).toBeNull();
  expect(row.getAttribute("data-unseen")).not.toBeNull();
  expect(mutate).not.toHaveBeenCalled();
  expect(address.read()).toBe("#/reads");

  act(() => address.visit("#/receipts"));
  act(() => address.visit("#/reads"));
  const returned = screen.getByRole("region", { name: "News stream" });
  expect(returned.textContent).toBe(preview);
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(within(returned).getByRole("button", { name: "Expand" }));
  await waitFor(() => expect(returned.querySelector("iframe")).not.toBeNull());
  expect(fetchBody.mock.calls).toEqual([[id]]);
});
