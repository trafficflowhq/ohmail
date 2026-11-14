/** @vitest-environment jsdom */
/**
 * THE RAIL's DIGITS ARE SHOWN BY THE SHEET, NOT BY A STATE (the switch's point 65): the frame hands every numbered entry
 * its digit always, and the rail's sheet shows it in place of the entry's own key only while the keys are within the
 * rail; at rest the entry's own key stands as before. A focus moving into or out of the rail draws nothing again.
 * The frame's rail is drawn in jsdom, then laid out in Chromium under every sheet the product page loads.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { FramePlaces, PaneProps, PlaceEntry, PlaceRail } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { chromium, pageOf } from "../support/browser-page.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function Wide({ route }: PaneProps) {
  return <p>at {route.place}</p>;
}
const place = (id: PlaceEntry["id"], rail: PlaceRail): PlaceEntry => ({
  id,
  body: id,
  rail,
  panes: { kind: "wide", Wide },
});
const PLACES: Partial<FramePlaces> = {
  ohbox: place("ohbox", {
    group: "main",
    icon: "ohbox",
    label: "title",
    keyHint: "g o",
    keyLabel: "goOhbox",
    keyStands: true,
  }),
  news: place("news", {
    group: "main",
    icon: "ohbox",
    label: "title",
    keyHint: "g r",
    keyLabel: "goReads",
    keyStands: true,
  }),
};
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), title: "Ohbox" },
  news: { title: "News" },
};

/* Every draw of a rail entry, counted where the frame takes the kit's entry from. */
const drawnEntries = vi.hoisted(() => ({ count: 0 }));
vi.mock("@ohmail/ui/mail", async (real) => {
  const kit = await real<typeof import("@ohmail/ui/mail")>();
  return {
    ...kit,
    RailEntry: (props: Parameters<typeof kit.RailEntry>[0]) => {
      drawnEntries.count += 1;
      return kit.RailEntry(props);
    },
  };
});

function drawn() {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/ohbox"),
    places: PLACES,
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
}

type Browser = Awaited<ReturnType<typeof chromium.launch>>;
let browser: Browser | null = null;
beforeAll(async () => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe("the rail's digits", () => {
  it("a focus moving into the rail and out of it draws no entry again", () => {
    drawn();
    const entries = () => [...document.querySelectorAll<HTMLElement>('nav[aria-label="Places"] button')];
    const news = entries().find((b) => /News/.test(b.textContent ?? ""));
    expect(news, "the rail's entry").toBeDefined();
    const before = drawnEntries.count;
    act(() => news!.focus());
    act(() => news!.blur());
    expect(drawnEntries.count - before, "entries drawn again on focus in and out").toBe(0);
    act(() => cleanup());
  });

  it("laid out: at rest the entry's own key stands and no digit; with the keys in the rail the digit stands in its place", async () => {
    drawn();
    const root = [...document.documentElement.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
    const html = document.body.innerHTML;
    act(() => cleanup());
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(pageOf({ html, root }));
    /* The face that prints keys on its controls, with a mouse: where an entry's own key stands at rest. */
    await page.evaluate(() => {
      document.documentElement.dataset.face = "ohmarchy";
      document.documentElement.dataset.touch = "0";
    });
    const keys = () =>
      page.evaluate(() => {
        const news = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Places"] button')].find(
          (b) => /News/.test(b.textContent ?? ""),
        )!;
        return [...news.querySelectorAll("kbd")]
          .filter((k) => k.getBoundingClientRect().width > 0)
          .map((k) => k.textContent);
      });
    expect(await keys(), "at rest").toEqual(["g r"]);
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLElement>('nav[aria-label="Places"] button')]
        .find((b) => /Ohbox/.test(b.textContent ?? ""))!
        .focus();
    });
    expect(await keys(), "the keys in the rail").toEqual(["2"]);
    await page.close();
  });
});
