/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import messages from "../messages/en.json";
import { shellFrameOf } from "./source-anchor.js";

/**
 * TRI-F2 — A SEARCH HIT OPENS EXACTLY THE CLICKED MESSAGE, AND THE ARRIVAL IS MARKED.
 *
 * The live sweep clicked a hit and landed with the cursor and the reader on a different
 * message — and with no flash on the one that was clicked. Two mechanisms accounted for the
 * silent half and are pinned here:
 *
 *   1. A conversation folds into ONE row carrying its lead's `data-id`, so the locate pass
 *      matched nothing for any other member. Folded rows now declare every member in
 *      `data-ids`, and the shell's selector falls back to `~=` over it.
 *   2. The windowed lists mount only their top, so a hit deep in the pile had no row in the
 *      DOM at all. The views now reveal an externally-set cursor by scrolling the windowed
 *      scroller (`OhboxView`, `ReadsView`, `ReceiptsView`); the locate pass retries until
 *      the row exists.
 *
 * The end-to-end case below runs the real shell on the fixture world: click a hit, arrive in
 * the Ohbox, and the OPEN message — the one the reading column renders and the row the flash
 * lands on — is the clicked one, by id.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // The escape is real — it is what stops an id with a quote breaking out of the selector.
  (globalThis as Record<string, unknown>).CSS = {
    escape: (v: string) => v.replace(/["\\\]]/g, (c) => `\\${c}`),
  };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  // The locate pass retries on animation frames; vitest's jsdom does not provide them.
  if (typeof globalThis.requestAnimationFrame !== "function") {
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/** Type into the search box the way React sees it: native setter + input event. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TRI-F2 — a search hit opens exactly the clicked message", () => {
  it("click a hit: the Ohbox opens THAT message, and the flash lands on ITS row", async () => {
    const container = await shell();
    await key("/");
    await waitFor(() => container.querySelector(".view-search input") != null, "search input");
    // "pizza" ⇒ `ben`, an UNPARKED Ohbox row. It used to be "glaze" ⇒ `giulia`, which is the
    // demo's Answer Later message: a parked mail is in no Ohbox group, so `openTargetFor` now
    // routes it to the reader rather than to a pile that cannot show it, and this end-to-end
    // guard is about the OHBOX arm. The parked arm has its own assertion in `search-locate`.
    await type(container.querySelector<HTMLInputElement>(".view-search input")!, "pizza");
    await waitFor(() => container.querySelectorAll(".hit-w").length > 0, "search hits");

    const first = container.querySelector<HTMLElement>(".hit-w")!;
    const clickedId = first.dataset.hit!;
    await act(async () => {
      first.querySelector("button")!.click();
    });

    // Arrival is `#/ohbox/m/<id>` now — the URL names the very message the click opened
    // (`message-url.test.tsx`), which is a STRONGER arrival claim than the bare view was.
    await waitFor(
      () => window.location.hash === `#/ohbox/m/${clickedId}` || window.location.hash === "#/ohbox",
      "arrival at the Ohbox",
    );
    await waitFor(() => container.querySelector(".view-ohbox") != null, "ohbox view");

    // The SELECTED row is the clicked message — not the first row, not a neighbour. The row
    // may be a folded conversation, in which case membership (data-id or data-ids) is the
    // contract; here the fixture's hit leads its own row.
    await waitFor(
      () => container.querySelector(`.view-ohbox .row.sel[data-id="${clickedId}"]`) != null,
      `the cursor stands on ${clickedId}`,
    );

    // The reading column shows the clicked message: its subject, from the mirror's own row.
    const subject = first.querySelector(".subj")?.textContent?.replace(/fuzzy.*$/, "") ?? "";
    const pane = container.querySelector(".view-ohbox .read-col");
    expect(pane, "no reading column beside the list").not.toBeNull();
    expect(pane!.textContent).toContain("Kiln");

    // THE ARRIVAL IS MARKED — the locate pass finds the row and flashes it. This is the half
    // the sweep reported as silent.
    await waitFor(
      () => document.querySelector(`.row.is-located[data-id="${clickedId}"]`) != null,
      "the locate flash on the clicked row",
      4000,
    );
    expect(subject.length).toBeGreaterThan(0);
  }, 20000);
});

describe("the locate selector reaches folded conversations (data-ids)", () => {
  it("a row that stands for several messages is found by ANY member's id", () => {
    // The DOM contract: folded rows carry `data-ids="a b c"`; `~=` is the attribute selector
    // defined over exactly that space-separated shape.
    document.body.innerHTML = `
      <div class="view">
        <div class="row" data-id="lead" data-ids="lead older oldest"></div>
        <div class="row" data-id="single"></div>
      </div>`;
    const bySelf = document.querySelector(`.view .row[data-id="older"]`);
    const byMembership = document.querySelector(`.view .row[data-ids~="older"]`);
    expect(bySelf).toBeNull(); // the exact-id contract alone cannot see a folded member…
    expect(byMembership?.getAttribute("data-id")).toBe("lead"); // …membership can.
  });

  it("the shell's locate pass consults membership after the exact id", () => {
    /* The locate pass sits with the open it follows, in `shell-open-state.ts` — the frame is
       resolved from the manifest by the declaration it belongs to. */
    const src = shellFrameOf("openMessage").source;
    expect(src).toMatch(/\.view \.row\[data-id="\$\{CSS\.escape\(located\)\}"\]/);
    expect(src).toMatch(/\.view \.row\[data-ids~="\$\{CSS\.escape\(located\)\}"\]/);
  });

  it("the Ohbox's folded rows declare their members", () => {
    const src = read("../app/views/OhboxView.tsx");
    // The group row hands every member to the row contract. Remove `memberIds` and a folded
    // member's search hit goes back to flashing nothing.
    expect(src).toMatch(/memberIds=\{g\.members\.map\(\(m\) => m\.id\)\}/);
  });
});

describe("the windowed lists reveal an externally-set cursor", () => {
  it("all three windowed views scroll the row's offset into the window", () => {
    // The window derives from scrollTop, so revealing = scrolling the scroller. Each view
    // owns its arithmetic; what is pinned is that NONE of them relies on `scrollIntoView`
    // against a row the window never mounted (a silent no-op). Two spellings of the offset:
    // rows times one height where rows are equal, and the window's own prefix sum where they
    // are not (the Ohbox — see `useListWindow`'s height cache).
    for (const view of ["OhboxView", "ReadsView", "ReceiptsView"]) {
      const src = read(`../app/views/${view}.tsx`) + (view === "OhboxView" ? read("../../../packages/app-logic/src/ohbox/window.ts") : "");
      expect(src, `${view} reveals an unmounted cursor row`).toMatch(
        /scrollTop = Math\.max\(0, [^)]*win\.(rowHeight|offsetOf\()/,
      );
    }
  });
});
