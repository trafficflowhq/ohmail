/** @vitest-environment jsdom */
/**
 * THE COLUMN WITH THE KEYS WEARS THE RING. Walking the columns with the arrows in the ohmarchy face, the column the keys
 * are in is drawn with the focus colour around its edge, every edge of it whole; in paper the columns keep their
 * resting edge, the keys shown by the cursor alone. The frame is drawn in jsdom with a reading place that stands a kit
 * sheet as the reader does, then laid out in Chromium under every sheet the product page loads.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useZoneNav } from "@ohmail/app-logic/keys";
import { Sheet } from "@ohmail/ui/mail";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { chromium, pageOf } from "../support/browser-page.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** A list whose row is where the keys stand in it, as a place's list says it to the zone walk. */
function List(_: PaneProps) {
  useZoneNav((key) => key, { listFocusSelector: "[data-the-row]" });
  return (
    <div style={{ height: 3000 }}>
      <button type="button" data-the-row="" aria-label="The row">
        the row
      </button>
    </div>
  );
}
function Reading({ route, keysHere }: PaneProps) {
  return (
    <Sheet kind="reading" label="Letter" focused={keysHere}>
      <p>{route.open ? `the letter ${route.open}` : "nothing open"}</p>
    </Sheet>
  );
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};

/** The frame's markup at an address; with `walk`, after the keys were taken from the list's row by those keys. */
async function drawn(at: string, walk: readonly string[] = []) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox },
    stages: {},
    window: fakeWindow({ ...ROOMS.desktop, posture: "flat", reducedMotion: false }),
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
  if (walk.length > 0) {
    act(() => screen.getByRole("button", { name: "The row" }).focus());
    for (const key of walk) fireEvent.keyDown(document.activeElement ?? document.body, { key });
    await act(async () => new Promise((done) => setTimeout(done, 40)));
  }
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

interface Seen {
  /** The colour of the focus, of the resting edge, and of each column's drawn edge (null: none drawn). */
  focus: string;
  rest: string;
  list: string | null;
  letter: string | null;
  rail: string | null;
  /** The zone the keys were in when the frame was drawn, as the frame says it on the document. */
  zone: string | undefined;
  /** How far each edge of the list's ring stands inside what clips it: never under 0. */
  room: number[];
}

/** The page at an address in a face, read once laid out. */
async function seen(at: string, face: "paper" | "ohmarchy", walk: readonly string[] = []): Promise<Seen> {
  const page = await browser!.newPage({
    viewport: { width: ROOMS.desktop.width, height: ROOMS.desktop.height },
  });
  try {
    await page.setContent(pageOf(await drawn(at, walk)));
    return await page.evaluate((f) => {
      document.documentElement.dataset.face = f;
      const tone = (v: string) => {
        const probe = document.createElement("i");
        probe.style.color = `var(${v})`;
        document.querySelector(".oh-root, body")!.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      /* The colour a box-shadow is drawn in, where one is drawn with a spread over 0. */
      const edge = (shadow: string): string | null => {
        if (!shadow || shadow === "none") return null;
        const m = /(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(shadow);
        return m && Math.abs(Number(m[5])) > 0 ? m[1]! : null;
      };
      const list = document.querySelector<HTMLElement>('.oh-sheet[data-kind="list"]')!;
      const letter = document.querySelector<HTMLElement>('.oh-sheet[data-kind="reading"]')!;
      const shadow = getComputedStyle(list).boxShadow;
      /* The ring's width: the spread of the shadow the list is drawn with. */
      const ring = Math.abs(
        Number(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(shadow)?.[4] ?? 0),
      );
      const box = list.getBoundingClientRect();
      const room: number[] = [];
      for (let up = list.parentElement; up; up = up.parentElement) {
        const cs = getComputedStyle(up);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const r = up.getBoundingClientRect();
        room.push(
          box.top - ring - r.top,
          r.right - (box.right + ring),
          r.bottom - (box.bottom + ring),
          box.left - ring - r.left,
        );
      }
      return {
        focus: tone("--focus"),
        rest: tone("--ring"),
        list: edge(shadow),
        letter: edge(getComputedStyle(letter, "::after").boxShadow),
        rail: edge(getComputedStyle(document.querySelector<HTMLElement>(".oh-rail")!).boxShadow),
        zone: document.documentElement.dataset.zone,
        room,
      };
    }, face);
  } finally {
    await page.close();
  }
}

describe("the column with the keys wears the ring", () => {
  it("in ohmarchy, the keys in the list: the list's edge is the focus colour, and the letter wears no ring", async () => {
    const m = await seen("#/ohbox", "ohmarchy");
    expect(m.focus).not.toBe(m.rest);
    expect(m.list, "the list with the keys wears no focus ring").toBe(m.focus);
    expect(m.letter).toBeNull();
  });

  it("in ohmarchy, the keys in the letter: the letter wears the focus ring, and the list its resting edge", async () => {
    const m = await seen("#/ohbox/m/a1", "ohmarchy");
    expect(m.letter, "the letter with the keys wears no focus ring").toBe(m.focus);
    expect(m.list).not.toBe(m.focus);
  });

  it("in ohmarchy, the keys walked into the rail with h: the rail wears the focus ring, and the list its resting edge", async () => {
    const m = await seen("#/ohbox", "ohmarchy", ["h"]);
    expect(m.zone, "the keys did not reach the rail").toBe("rail");
    expect(m.rail, "the rail with the keys wears no focus ring").toBe(m.focus);
    expect(m.list, "the list wears the ring while the keys are in the rail").not.toBe(m.focus);
  });

  it("in paper, no column wears a ring for the keys: the list keeps its resting edge, the letter none", async () => {
    for (const at of ["#/ohbox", "#/ohbox/m/a1"]) {
      const m = await seen(at, "paper");
      expect(m.list, at).not.toBe(m.focus);
      expect(m.letter, at).toBeNull();
    }
  });

  it("in ohmarchy the ring is whole: none of its four edges is cut by what holds the column", async () => {
    const m = await seen("#/ohbox", "ohmarchy");
    for (const r of m.room)
      expect(r, "an edge of the ring stands outside what clips it").toBeGreaterThanOrEqual(-0.5);
  });
});
