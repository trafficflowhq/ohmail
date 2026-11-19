/** @vitest-environment jsdom */
/**
 * THE JS HALVES OF THE LISTS-AND-CARDS FIXES, where each one is a decision a unit test can watch:
 *
 *   · StreamCard measures whether a rendered viewer FITS its clamp (`viewerFits`) and says so as
 *     `.short`, which hides the pill and the fade together — the one condition of the pair.
 *   · ListPane says the scroller's edges on the column (`data-scrolled`, `data-more-below`).
 *   · HistoryRail writes its width as the rows' gutter and takes it back off when it unmounts.
 *   · The first-sync pill writes its own height to `--pill-h` and takes it back off.
 *
 * jsdom lays nothing out, so every size is stood in for by a getter stub; the geometry is
 * `lists-and-cards-geometry.test.tsx`'s.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
process.env.NEXT_PUBLIC_API_BASE ??= "/api";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ListPane, StreamCard } from "@ohmail/ui";
import en from "../messages/en.json";
import { HistoryRail } from "../app/views/HistoryRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return { host, root };
}

/** A ResizeObserver whose callbacks the test fires. */
class FakeRO {
  static all: FakeRO[] = [];
  observed: Element[] = [];
  constructor(public cb: () => void) { FakeRO.all.push(this); }
  observe(el: Element) { this.observed.push(el); }
  unobserve() {}
  disconnect() { this.observed = []; }
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("a viewer card's pill and fade are one condition: the clip overflows", () => {
  const card = (slot: React.ReactNode) => (
    <StreamCard id="c1" from="Harbour Supply" time="21 Sep" subject="s" body="b" expandLabel="Expand" collapseLabel="Collapse" bodySlot={slot} />
  );

  it("a viewer whose mail fits the clamp is `.short`; one that overruns it is not, and the class follows a resize", async () => {
    FakeRO.all = [];
    vi.stubGlobal("ResizeObserver", FakeRO);
    let h = 200;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sc-clip") ? h : 0;
    });
    const { host } = await mount(card(<div className="probe" />));
    const el = host.querySelector(".scast")!;
    expect(el.classList.contains("short"), "a 200px mail under a 348px clamp still draws the pill").toBe(true);
    // The viewer grows past the clamp once its frame has measured the mail.
    h = 900;
    const ro = FakeRO.all.find((o) => o.observed.length > 0)!;
    expect(ro, "the clip's content is not observed — a viewer that sizes itself later is never re-read").toBeTruthy();
    await act(async () => ro.cb());
    expect(el.classList.contains("short"), "a cut mail has no pill").toBe(false);
  });

  it("a short card still opens through its pill — the press the stream's Enter makes", async () => {
    // HAND BACK H1: a fitting card's pill is drawn only under keyboard focus, and `toggle()` used
    // to return early for a short card, so Enter (`.sc-x.click()`) opened nothing and the verbs and
    // files an open card mounts were out of a keyboard's reach. Mutation: restore the early return.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sc-clip") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
    for (const slot of [<div className="probe" key="v" />, null]) {
      const { host } = await mount(
        <StreamCard id="c1" from="Harbour Supply" time="21 Sep" subject="s" body="Paid, thank you." expandLabel="Expand"
          collapseLabel="Collapse" bodySlot={slot ?? undefined} />,
      );
      const card = host.querySelector(".scast")!;
      expect(card.classList.contains("short"), "premise: a card whose mail fits").toBe(true);
      const pill = host.querySelector<HTMLButtonElement>(".sc-x")!;
      await act(async () => pill.click());
      expect(pill.getAttribute("aria-expanded"), `a short ${slot ? "rendered" : "text"} card did not open`).toBe("true");
      expect(card.classList.contains("open")).toBe(true);
    }
  });

  it("a keyboard open of a short card hands focus to its first verb, not to the page", async () => {
    // VERIFY L1: the pill is removed on the open card, so the press that opened it left focus on
    // the page and the next Tab went to the top. The caller mounts the verbs once the card reports
    // it is open, as the streams do. Mutation: drop the `first.focus()`.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sc-clip") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
    function Host() {
      const [open, setOpen] = React.useState(false);
      return (
        <StreamCard id="c1" from="Harbour Supply" time="21 Sep" subject="s" body="Paid, thank you." expandLabel="Expand"
          collapseLabel="Collapse" onToggle={setOpen}
          actions={open ? <><button type="button" className="v-reply">Reply</button><button type="button">Later</button></> : undefined} />
      );
    }
    const { host } = await mount(<Host />);
    expect(host.querySelector(".scast")!.classList.contains("short"), "premise: a card whose mail fits").toBe(true);
    const pill = host.querySelector<HTMLButtonElement>(".sc-x")!;
    pill.focus();
    await act(async () => pill.click());
    expect(document.activeElement?.className, "focus did not reach the open card's first verb").toBe("v-reply");
  });

  it("a pointer open (the pill not focused) moves nobody's focus", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sc-clip") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
    const { host } = await mount(
      <StreamCard id="c1" from="Harbour Supply" time="21 Sep" subject="s" body="b" expandLabel="Expand" collapseLabel="Collapse"
        actions={<button type="button" className="v-reply">Reply</button>} />,
    );
    await act(async () => host.querySelector<HTMLButtonElement>(".sc-x")!.click());
    expect(document.activeElement?.className ?? "").not.toBe("v-reply");
  });

  it("one threshold with the clip: a rendered mail 349-376px tall is cut, so it is not short", async () => {
    // HAND BACK LOW 2: the short test allowed 28px past the clamp while the viewer's clip cut at
    // 348, so up to 28px went missing with neither fade nor pill. Mutation: put `+ 28` back.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sc-clip") ? 360 : 0;
    });
    const { host } = await mount(card(<div className="probe" />));
    expect(host.querySelector(".scast")!.classList.contains("short"), "a 360px mail cut at 348 reads as fitting").toBe(false);
  });

  it("an unmeasured viewer (jsdom's 0) keeps its pill: no measurement, no claim", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(0);
    const { host } = await mount(card(<div className="probe" />));
    expect(host.querySelector(".scast")!.classList.contains("short")).toBe(false);
  });
});

describe("ListPane says its scroller's edges on the column", () => {
  it("data-scrolled once rows went up, data-more-below while rows continue", async () => {
    const { host } = await mount(<ListPane title="Ohbox"><div className="rows" /></ListPane>);
    const col = host.querySelector(".list-col")!;
    const sc = host.querySelector<HTMLElement>(".scroller")!;
    Object.defineProperty(sc, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(sc, "scrollHeight", { configurable: true, value: 1200 });
    sc.scrollTop = 0;
    await act(async () => { sc.dispatchEvent(new Event("scroll")); await frame(); });
    expect(col.hasAttribute("data-scrolled")).toBe(false);
    expect(col.hasAttribute("data-more-below")).toBe(true);
    sc.scrollTop = 800;
    await act(async () => { sc.dispatchEvent(new Event("scroll")); await frame(); });
    expect(col.hasAttribute("data-scrolled"), "a list scrolled 800px is not marked").toBe(true);
    expect(col.hasAttribute("data-more-below"), "a list at its end is still marked as continuing").toBe(false);
  });
});

describe("History's rail reserves its own width beside the rows", () => {
  it("writes --history-gutter from its measured width, and removes it on unmount", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("history-rail") ? 73.4 : 0;
    });
    const segments = [
      { month: "2026-10", start: 0, count: 3 },
      { month: "2026-09", start: 3, count: 4 },
    ];
    const host = document.createElement("div");
    host.className = "scroller";
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <HistoryRail segments={segments as never} at={0} onJump={() => {}} />
      </NextIntlClientProvider>,
    ));
    expect(host.style.getPropertyValue("--history-gutter")).toBe("74px");
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(host.style.getPropertyValue("--history-gutter"), "the gutter outlived the rail").toBe("");
  });
});
