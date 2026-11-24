/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Frame, useFrame } from "../../src/frame/index.js";
import { segmentOf, ScreenerAbove, screenerPlace } from "../../src/screener/index.js";
import { ScreenerPrimer } from "../../src/screener/Primer.js";
import { fakeHost, SEAM_AT_REST } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { BESIDE, TestConsent, inWords, modelOf, screenerEngine, sender } from "./screener-world.js";

function correspondent(id: string, subject: string) {
  return sender(id, "Held correspondent", {
    held: [{ id, time: "09:00", subject, snippet: "Preview should wait" }],
  }) as ScreenerSenderDTO;
}

function mount(at: string) {
  const { engine, asked } = screenerEngine();
  const model = modelOf(
    { flushes: 0 },
    {
      waiting: [correspondent("waiting", "Still waiting")],
      waitingCount: 1,
      screenedOut: [correspondent("screened", "Kept out letter")],
      spam: [{ sender: correspondent("spam", "Spam letter"), pinned: false }],
    },
  );
  function Above({ children }: { children: ReactNode }) {
    const { route } = useFrame();
    return (
      <ScreenerAbove model={model} beside={BESIDE}>
        <ScreenerPrimer active={route.place === "screener" ? segmentOf(route.sub) : null} />
        {children}
      </ScreenerAbove>
    );
  }
  const address = fakeAddress(at);
  const { host } = fakeHost({
    address,
    engine: { ...SEAM_AT_REST, ...engine } as typeof engine,
    above: Above,
    places: { screener: screenerPlace },
    scope: "acct-1",
    service: "self",
  });
  render(
    inWords(
      <TestConsent scope="acct-1" transport="none">
        <Frame host={host} />
      </TestConsent>,
    ),
  );
  return { address, asked };
}

const frames = new Map<number, FrameRequestCallback>();
const hidden = () =>
  [...document.querySelectorAll("[inert][aria-hidden=true]")].find((node) =>
    node.querySelector("[role=listbox], article"),
  );

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  localStorage.clear();
  frames.clear();
  let id = 0;
  vi.spyOn(document.body, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 900, 800),
  ] as unknown as DOMRectList);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  await act(async () => {
    callbacks.forEach((callback) => callback(performance.now()));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it("warms each list and its letter heads one frame at a time without asking for bodies", async () => {
  const { asked } = mount("#/ohbox");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await paint();
  await tick(399);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
  });
  await tick(399);
  expect(hidden()).toBeUndefined();

  for (const subject of ["Still waiting", "Kept out letter", "Spam letter"]) {
    await tick(400);
    expect(hidden()?.querySelectorAll("[role=option]")).toHaveLength(1);
    expect(hidden()?.querySelector("article")).toBeNull();
    await paint();
    expect(hidden()).toBeUndefined();
    await paint();
    await tick(400);
    const article = hidden()?.querySelector("article");
    expect(article?.querySelector("h2")?.textContent).toBe(subject);
    expect(article?.textContent).not.toContain("Preview should wait");
    expect(article?.querySelector("iframe")).toBeNull();
    await paint();
    expect(hidden()).toBeUndefined();
    await paint();
  }
  expect(asked.bodies).toEqual([]);
  await tick(1000);
  expect(hidden()).toBeUndefined();
});

it("primes the other sections without looking up their bodies while Waiting is open", async () => {
  const { asked, address } = mount("#/screener");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(hidden()).toBeUndefined();
  await paint();
  expect(hidden()?.querySelectorAll("[role=option]")).toHaveLength(2);
  expect([...hidden()!.querySelectorAll("article h2")].map((heading) => heading.textContent)).toEqual([
    "Kept out letter",
    "Spam letter",
  ]);
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await paint();
  expect(hidden()).toBeUndefined();
  expect(asked.bodies).toEqual(["waiting urgent"]);

  vi.useRealTimers();
  await act(async () => {
    address.visit("#/ohbox");
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await paint();
  await tick(1000);
  expect(hidden()).toBeUndefined();
  expect(asked.bodies).toEqual(["waiting urgent"]);
});
