/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageBodyRecord } from "@ohmail/wire";
import type { ReaderBody } from "../../src/reader/index.js";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const)(
  "%s keeps newly fetched bodies hidden and unread until the card opens",
  async (route, name, message) => {
    const { letterBody } = await vi.importActual<{ letterBody: ReaderBody }>(
      "../../src/reader/body/index.js",
    );
    const visible: Array<() => void> = [];
    const fetchRemote = vi.fn();
    vi.stubGlobal("fetch", fetchRemote);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          private report: IntersectionObserverCallback,
          private options?: IntersectionObserverInit,
        ) {}
        observe(target: Element) {
          if (this.options?.rootMargin === "100% 0px" && target.hasAttribute("data-stream-item")) {
            visible.push(() =>
              this.report(
                [{ target, isIntersecting: true } as IntersectionObserverEntry],
                this as unknown as IntersectionObserver,
              ),
            );
          }
        }
        disconnect() {}
      },
    );
    const letters = [
      message("first", 12, { unread: route === "reads", body: undefined }),
      message("second", 11, { unread: true, body: undefined }),
    ];
    const { mail } = mountStreamFrame({ at: `#/${route}`, letters, readerBody: letterBody });
    const remote = "https://sender-pictures.example.test/cover.png";
    const cache = new Map<string, MessageBodyRecord>();
    const mirror = mail.engine.read();
    const get = mirror.get.bind(mirror);
    vi.spyOn(mirror, "get").mockImplementation((type, id) =>
      type === "message_body" ? cache.get(id) : get(type, id),
    );
    const hydrate = mail.engine.hydrateBody.bind(mail.engine);
    const answer = (id: string) => {
      const text = `Full body for ${id}`;
      cache.set(id, {
        messageId: id,
        state: "ready",
        text,
        loadedRemoteContent: false,
        html: `<table width="600" cellpadding="0"><tr><td><h1>${text}</h1><img src="${remote}" width="600" height="200"></td></tr></table>`,
      });
      mail.patch(id, {});
    };
    vi.spyOn(mail.engine, "hydrateBody").mockImplementation(async (id, options) => {
      await hydrate(id, options);
      answer(id);
    });
    const cursor = route === "reads" ? "first" : "second";
    const requested = route === "reads" ? ["first", "second"] : [cursor];
    expect(mail.bodyAsks).toEqual(route === "reads" ? [] : [cursor]);
    if (route === "receipts") act(() => answer(cursor));
    const region = screen.getByRole("region", { name: `${name} stream` });
    const scroll = region.querySelector<HTMLElement>(".oh-sheet-scroll")!;
    scroll.scrollTo = vi.fn();
    const stream = within(region);
    expect(stream.getByRole("heading", { name: letters[0].subject! })).toBeTruthy();
    await act(async () => {
      for (const report of visible) report();
    });
    expect(mail.bodyAsks).toEqual(requested);
    expect([...cache.keys()]).toEqual(requested);
    expect(stream.queryByRole("button", { name: "Collapse" })).toBeNull();
    expect(stream.getByText("snippet of first")).toBeTruthy();
    expect(stream.getByText("snippet of second")).toBeTruthy();
    expect(region.querySelector(`iframe, img[src="${remote}"]`)).toBeNull();
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(mail.mutations).toEqual([]);

    fireEvent.click(stream.getByRole("heading", { name: letters.find(({ id }) => id === cursor)!.subject! }));
    expect(stream.getByRole("button", { name: "Collapse" })).toBeTruthy();
    await waitFor(() => expect(region.querySelector("iframe")?.srcdoc).toContain(`Full body for ${cursor}`));
    expect(region.querySelectorAll("iframe")).toHaveLength(1);
    expect(stream.getByText(route === "reads" ? "snippet of second" : "snippet of first")).toBeTruthy();
    expect(mail.bodyAsks).toEqual(requested);
    expect(fetchRemote).not.toHaveBeenCalled();
  },
);
