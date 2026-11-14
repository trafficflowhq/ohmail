/** @vitest-environment jsdom */
/**
 * THE ROOMS, LAID OUT IN A REAL BROWSER. Where the frame stands its columns in each room the design draws, and what a
 * phone draws at its foot while a letter is open. The frame is drawn in jsdom with a reading place whose foot is the
 * kit's action panel (the reader's), then laid out in Chromium under every sheet the product page loads.
 */
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionPanel } from "@ohmail/ui/mail";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { chromium, entryPageOf, pageOf } from "../support/browser-page.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List(_: PaneProps) {
  return <div style={{ height: 3000 }}>the list</div>;
}
/**
 * A letter, and at its foot the reader's panel: the kit's, at the inset the design gives it on a phone, with the verbs
 * the reader shows there at 390 (the rest behind More: the panel's own fit runs in a script the laid-out page has not).
 */
function Reading({ route }: PaneProps) {
  return (
    <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
      <p>{route.open ? `the letter ${route.open}` : "nothing open"}</p>
      {route.open ? (
        <div style={{ position: "absolute", left: "var(--s4)", right: "var(--s4)", bottom: "var(--s4)" }}>
          <ActionPanel
            label="Letter"
            items={[
              { id: "reply", label: "Reply", icon: "reply", kind: "ink", rank: 0 },
              { id: "read", label: "Mark unread", icon: "unread", rank: 0, apart: true },
            ]}
            more={{ label: "More", behind: true }}
          />
        </div>
      ) : null}
    </div>
  );
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};

/** The frame's markup in a room at an address, with the root's attributes it stamped. */
function drawn(
  room: { width: number; height: number; pointer: "coarse" | "fine" },
  at: string,
  above?: FakeHostInput["above"],
) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox },
    stages: {},
    window: fakeWindow({ ...room, posture: "flat", reducedMotion: false }),
    address: fakeAddress(at),
    above,
  });
  const { container } = render(
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
  const inner = container.innerHTML;
  act(() => cleanup());
  return { html, root, inner };
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

async function opened(room: { width: number; height: number; pointer: "coarse" | "fine" }, at: string) {
  const page = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
  await page.setContent(pageOf(drawn(room, at)));
  return page;
}

describe("a phone's foot while a letter is open", () => {
  it("390 by 844: every control of the letter's panel is the control under its middle, and no dock is drawn", async () => {
    const page = await opened(ROOMS.phone, "#/ohbox/m/a1");
    const seen = await page.evaluate(() => {
      const panel = document.querySelector('[role="toolbar"][aria-label="Letter"]')!;
      const controls = [...panel.querySelectorAll<HTMLElement>("button:not([hidden])")];
      const hits = controls.map((control) => {
        const r = control.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          name: control.getAttribute("aria-label") ?? control.textContent,
          hit: !!top && control.contains(top),
        };
      });
      const docks = [...document.querySelectorAll('nav[aria-label="Places"]')].filter(
        (nav) => nav.getBoundingClientRect().height > 0,
      );
      return { hits, docks: docks.length };
    });
    await page.close();
    expect(seen.hits.map((h) => h.name)).toEqual(["Reply", "Mark unread", "More"]);
    expect(
      seen.hits.filter((h) => !h.hit).map((h) => h.name),
      "a control stands under the dock",
    ).toEqual([]);
    expect(seen.docks, "a dock is drawn over the letter").toBe(0);
  });

  it("390 by 844: the dock stands at the foot at rest, with no letter open", async () => {
    const page = await opened(ROOMS.phone, "#/ohbox");
    const dock = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Places"]');
      if (!nav) return null;
      const r = nav.getBoundingClientRect();
      const write = [...nav.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Write");
      const w = write?.getBoundingClientRect();
      const top = w ? document.elementFromPoint(w.x + w.width / 2, w.y + w.height / 2) : null;
      return {
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        write: !!write && write.contains(top),
      };
    });
    await page.close();
    expect(dock, "no dock at rest").not.toBeNull();
    expect(dock!.height).toBeGreaterThan(0);
    expect(dock!.bottom).toBe(ROOMS.phone.height - 16);
    expect(dock!.write, "Write is not on screen").toBe(true);
  });

  it("390 by 844: the report's place is over the letter's panel while a letter is open, and over the dock without one", async () => {
    const placed = async (at: string) => {
      const page = await opened(ROOMS.phone, at);
      const seen = await page.evaluate(() => {
        const top = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top) : null);
        const report = document.querySelector(".fr-report")!.getBoundingClientRect();
        return {
          /* How far over the window's foot the report's own foot stands. */
          over: Math.round(window.innerHeight - report.bottom),
          foot: Math.round(report.bottom),
          panel: top(document.querySelector('[role="toolbar"][aria-label="Letter"]')),
          dock: top(document.querySelector('nav[aria-label="Places"]')),
        };
      });
      await page.close();
      return seen;
    };
    /* The design's sums at a finger's sizes: s4 + h-m + s3 + s4 with a letter open, s4 + h-xl + s3 over the dock. */
    const open = await placed("#/ohbox/m/a1");
    expect(open.over, "the report's place with a letter open").toBe(16 + 44 + 12 + 16);
    expect(open.panel, "no panel at the letter's foot").not.toBeNull();
    expect(open.foot, "the report lies on the letter's panel").toBeLessThan(open.panel!);
    const closed = await placed("#/ohbox");
    expect(closed.over, "the report's place over the dock").toBe(16 + 56 + 12);
    expect(closed.foot, "the report lies on the dock").toBeLessThan(closed.dock!);
  });
});

/**
 * The columns as the design's reference draws them. Beside the upright rail of an unfolded phone the list runs from x 88
 * (the edge 12, the icon rail 64, the gap 12) to the window's middle less half the gap, never under 300 wide, and the
 * letter takes the rest to the edge. The desktop's and the phone's stand as their references draw them too.
 */
describe("the columns in each room, with a letter open", () => {
  for (const [name, room, list, reading] of [
    ["the unfolded phone upright, 719 wide", ROOMS.fold, { x: 88, width: 300 }, { x: 400, width: 307 }],
    ["the unfolded phone on its side, 841 wide", ROOMS.land, { x: 88, width: 327 }, { x: 427, width: 402 }],
    ["the desktop, 1440 wide", ROOMS.desktop, { x: 256, width: 420 }, { x: 688, width: 740 }],
    [
      "the phone, 390 wide: the letter over the list",
      ROOMS.phone,
      { x: 0, width: 390 },
      { x: 0, width: 390 },
    ],
  ] as const) {
    it(`${name}: the list and the letter stand where the reference draws them`, async () => {
      const page = await opened(room, "#/ohbox/m/a1");
      const columns = await page.evaluate(() => {
        const at = (label: string) => {
          const r = document.querySelector(`section[aria-label="${label}"]`)!.getBoundingClientRect();
          return { x: Math.round(r.x), width: Math.round(r.width) };
        };
        return { list: at("Messages"), reading: at("Reading") };
      });
      await page.close();
      expect(columns).toEqual({ list, reading });
    });
  }
});

/**
 * WHERE TWO COLUMNS BEGIN: at 700 wide, as the design draws it (a rail, a list and a letter at the reader's floor of
 * 320 need about that much). Narrower, one column stands with the dock at its foot: the open Duo, 669 by 951, as its
 * reference draws it, the dock a phone's measure of 440 in the middle of the window's foot.
 */
describe("where two columns begin", () => {
  const room = (width: number, height = 951) => ({ width, height, pointer: "coarse" as const });
  async function laid(width: number, at: string) {
    const page = await opened(room(width), at);
    const seen = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), width: Math.round(r.width) };
      };
      const docks = [...document.querySelectorAll('nav[aria-label="Places"]')].map((nav) => {
        const r = nav.getBoundingClientRect();
        /* To the half pixel: the reference lays the dock at 114.5 at 669 wide. */
        return { x: Math.round(r.x * 2) / 2, width: Math.round(r.width), bottom: Math.round(r.bottom) };
      });
      return {
        list: box(document.querySelector('section[aria-label="Messages"]')),
        reading: box(document.querySelector('section[aria-label="Reading"]')),
        docks,
      };
    });
    await page.close();
    return seen;
  }

  it("669 by 951, the open Duo: one column, the dock at the foot in the middle, and the letter over the list", async () => {
    const rest = await laid(669, "#/ohbox");
    expect(rest.list).toEqual({ x: 0, width: 669 });
    expect(rest.reading, "a reading column beside the list").toBeNull();
    expect(rest.docks).toEqual([{ x: 114.5, width: 440, bottom: 951 - 16 }]);
    const open = await laid(669, "#/ohbox/m/a1");
    expect(open.reading).toEqual({ x: 0, width: 669 });
    expect(open.docks, "a dock is drawn over the letter").toEqual([]);
  });

  it("669 by 951: the report keeps a phone's measure with the dock, at rest and with a letter open", async () => {
    const slot = async (width: number, at: string) => {
      const page = await opened(room(width), at);
      const seen = await page.evaluate(() => {
        const r = document.querySelector(".fr-report")!.getBoundingClientRect();
        return { x: Math.round(r.x * 2) / 2, width: Math.round(r.width) };
      });
      await page.close();
      return seen;
    };
    expect(await slot(669, "#/ohbox"), "the report over the dock").toEqual({ x: 114.5, width: 440 });
    expect(await slot(669, "#/ohbox/m/a1"), "the report over the letter's panel").toEqual({
      x: 114.5,
      width: 440,
    });
    /* A phone's own width keeps the report at s4 from each side. */
    expect(await slot(390, "#/ohbox")).toEqual({ x: 16, width: 358 });
  });

  it("699 wide: still one column, the dock at the foot", async () => {
    const rest = await laid(699, "#/ohbox");
    expect(rest.list).toEqual({ x: 0, width: 699 });
    expect(rest.reading).toBeNull();
    expect(rest.docks.map((d) => d.width)).toEqual([440]);
  });

  it("700 wide: two columns beside the upright rail, the list at its floor of 300", async () => {
    const open = await laid(700, "#/ohbox/m/a1");
    expect({ list: open.list, reading: open.reading }).toEqual({
      list: { x: 88, width: 300 },
      reading: { x: 400, width: 288 },
    });
    expect(
      open.docks.map((d) => d.x),
      "the rail stands upright at the edge",
    ).toEqual([12]);
  });
});

describe("an entry that mounts the frame in #root (the desktop window, the paired page)", () => {
  it.each(Object.entries(ROOMS))(
    "%s: the frame's box is the window's, and the document does not scroll",
    async (_name, room) => {
      const page = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
      await page.setContent(entryPageOf(drawn(room, "#/ohbox")));
      const seen = await page.evaluate(() => {
        const frame = document.querySelector(".fr-root")!;
        window.scrollTo(0, 10_000);
        return {
          parent: frame.parentElement!.id,
          frame: frame.getBoundingClientRect().height,
          scrolled: window.scrollY,
        };
      });
      await page.close();
      /* The list here is 3000 high: a frame that grew to it would be as high, and the document would scroll. */
      expect(seen).toEqual({ parent: "root", frame: room.height, scrolled: 0 });
    },
  );
});

/**
 * WHAT A SHELL STANDS ABOVE THE PANES TAKES NO BOX IN THE FRAME'S LAYOUT. A shell's own nodes there are overlays; here
 * it draws the worst it could beside what it is handed: a block in the flow, 200 px tall, and a sheet over the window.
 * In every room each landmark of the frame stands exactly where it stands with nothing above.
 */
describe("what a shell stands above the panes", () => {
  function Above({ children }: { children: ReactNode }) {
    return (
      <>
        {children}
        <div style={{ height: 200 }}>a block in the flow</div>
        <div role="dialog" aria-label="A sheet of the shell" style={{ position: "fixed", inset: 40 }}>
          over the window
        </div>
      </>
    );
  }
  /** Where the frame's landmarks stand: the rail or the dock, the main landmark, the list and the reading column. */
  const landmarks = () =>
    Object.fromEntries(
      ["nav", "main", "section[aria-label='Messages']", "section[aria-label='Reading']"].flatMap((find) =>
        [...document.querySelectorAll(find)].map((el, at) => {
          const box = el.getBoundingClientRect();
          return [
            `${find} ${at}`,
            [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 100) / 100),
          ];
        }),
      ),
    );

  for (const [name, room, at] of [
    ["a phone, a letter open", ROOMS.phone, "#/ohbox/m/a1"],
    ["a phone, at rest", ROOMS.phone, "#/ohbox"],
    ["a fold", ROOMS.fold, "#/ohbox/m/a1"],
    ["the desktop", ROOMS.desktop, "#/ohbox/m/a1"],
  ] as const) {
    it(`${name}: every landmark stands where it stands with nothing above, and the page is no taller`, async () => {
      const measure = async (above?: FakeHostInput["above"]) => {
        const page = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
        await page.setContent(pageOf(drawn(room, at, above)));
        const seen = {
          landmarks: await page.evaluate(landmarks),
          pageHeight: await page.evaluate(() => document.documentElement.scrollHeight),
          sheet: await page.getByRole("dialog", { name: "A sheet of the shell" }).count(),
        };
        await page.close();
        return seen;
      };
      const bare = await measure();
      const under = await measure(Above);
      expect(under.sheet, "the shell's sheet was not drawn").toBe(1);
      expect(Object.keys(bare.landmarks).length, "no landmark was measured").toBeGreaterThan(2);
      expect(under.landmarks).toEqual(bare.landmarks);
      expect(under.pageHeight).toBe(bare.pageHeight);
    });
  }
});
