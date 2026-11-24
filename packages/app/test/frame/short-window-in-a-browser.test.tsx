/** @vitest-environment jsdom */
/**
 * A SHORT WINDOW KEEPS THE LIST MOST OF ITS HEIGHT. A phone on its side, or a small window under 480 high: nothing the
 * frame stands above the list takes the room, and the list's column is one window tall, so a windowed list keeps a
 * bounded box and the page itself never scrolls. The frame is drawn in jsdom and laid out in Chromium under every
 * sheet the product page loads, as `rooms-in-a-browser.test.tsx` does.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { chromium, pageOf } from "../support/browser-page.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List(_: PaneProps) {
  return <div style={{ height: 3000 }}>the list</div>;
}
function Reading({ route }: PaneProps) {
  return <p>{route.open ? `the letter ${route.open}` : "nothing open"}</p>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};

type Room = { width: number; height: number; pointer: "coarse" | "fine" };

function drawn(room: Room, at: string) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox },
    stages: {},
    window: fakeWindow({ ...room, posture: "flat", reducedMotion: false }),
    address: fakeAddress(at),
  });
  render(
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
      timeZone="Europe/Zurich"
    >
      <Frame host={host} />
    </TextProvider>,
  );
  const root = [...document.documentElement.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
  const html = document.body.innerHTML;
  act(() => cleanup());
  return { html, root };
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

/** The list's column and the page, laid out in the room. */
async function list(room: Room) {
  const page = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
  try {
    await page.setContent(pageOf(drawn(room, "#/ohbox")));
    return await page.evaluate(() => {
      const r = document.querySelector('section[aria-label="Messages"]')!.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        window: innerHeight,
        page: document.documentElement.scrollHeight,
      };
    });
  } finally {
    await page.close();
  }
}

const SHORT: ReadonlyArray<readonly [string, Room]> = [
  ["a phone on its side, 844 by 390", { width: 844, height: 390, pointer: "coarse" }],
  ["a small window, 640 by 400", { width: 640, height: 400, pointer: "coarse" }],
  ["a short desktop window, 1024 by 460", { width: 1024, height: 460, pointer: "fine" }],
];

describe("a short window keeps the list most of the height", () => {
  for (const [name, room] of SHORT) {
    it(`${name}: nothing stands above the list to take its room`, async () => {
      const m = await list(room);
      expect(m.height / m.window, "the list keeps under nine tenths of the window").toBeGreaterThanOrEqual(
        0.9,
      );
    });
    it(`${name}: the list's column is one window tall, and the page does not scroll`, async () => {
      const m = await list(room);
      expect(m.bottom, "the list's column runs past the window").toBeLessThanOrEqual(m.window + 0.5);
      expect(m.page, "the page scrolls").toBeLessThanOrEqual(m.window);
    });
  }
});
