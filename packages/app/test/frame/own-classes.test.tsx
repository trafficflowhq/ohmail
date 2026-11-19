/** @vitest-environment jsdom */
/**
 * THE FRAME'S OWN CLASSES ARE ITS OWN. Today's sheets (the old kit's, the web app's, the desktop's) are loaded on the
 * same page as the frame and are unlayered, so a class name they style that the frame also draws is styled twice:
 * the frame's notice bar once took the name of the Reply Run's 1.5 px progress bar and drew as an empty grey band on
 * a phone. Every class the frame draws, at every size, with its rail sheet and its stage open, is styled by none of
 * them.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useNotice } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, StageEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const REPO = resolve(__dirname, "../../../..");
/** Where today's sheets live. */
const TODAYS_TREES = ["packages/ui/src", "apps/webapp/app", "apps/desktop/src", "apps/paired-page/src"];
/** The new kit's own sheets, and the adapter's sheet that places today's views inside the frame. */
const NOT_TODAYS = new Set(["packages/ui/src/base/base.css"]);

function sheetsUnder(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sheetsUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Every class a sheet's selectors name, comments and strings left out. */
function classesStyledBy(css: string): Set<string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "");
  const selectors = bare.match(/[^{}]+(?=\{)/g) ?? [];
  return new Set(selectors.flatMap((s) => [...s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!)));
}

function Pane({ route }: PaneProps) {
  useNotice({ kind: "trial", title: "Trial ends Wed 18 Nov", line: "Then it is read-only." });
  useNotice({ kind: "offline", title: "Offline" });
  return <p>at {route.place}</p>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List: Pane, Reading: Pane },
};
const news: PlaceEntry = {
  id: "news",
  body: "news",
  rail: { group: "main", icon: "news", label: "title" },
  panes: { kind: "wide", Wide: Pane },
};
const firstRun: StageEntry = { id: "firstRun", Body: () => <p>first run</p> };

function drawnClasses(): Set<string> {
  const drawn = new Set<string>();
  const take = () =>
    document.querySelectorAll("[class]").forEach((el) => el.classList.forEach((c) => drawn.add(c)));
  for (const room of Object.keys(ROOMS) as (keyof typeof ROOMS)[]) {
    for (const where of ["#/ohbox/m/a1", "#/reads", "#/first-run"]) {
      const window = fakeWindow(room);
      const { host } = fakeHost({
        engine: NO_ENGINE,
        service: "self",
        scope: "acct-1",
        places: { ohbox, news },
        stages: { firstRun },
        window,
        address: fakeAddress(where),
      });
      render(
        <TextProvider
          locale="en"
          messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" }, news: { title: "News" } }}
          timeZone="Europe/Zurich"
        >
          <Frame host={host} />
        </TextProvider>,
      );
      take();
      const more = screen.queryByRole("button", { name: "More" });
      if (more) {
        act(() => fireEvent.click(more));
        take();
      }
      cleanup();
    }
  }
  return drawn;
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the classes the frame draws", () => {
  it("are styled by none of today's sheets", () => {
    const drawn = [...drawnClasses()].filter((c) => !c.startsWith("oh-"));
    const sheets = TODAYS_TREES.flatMap(sheetsUnder).filter((p) => !NOT_TODAYS.has(p));
    expect(sheets.length).toBeGreaterThan(20);
    const clashes = sheets.flatMap((path) => {
      const styled = classesStyledBy(readFileSync(join(REPO, path), "utf8"));
      return drawn.filter((c) => styled.has(c)).map((c) => `.${c} in ${relative(REPO, join(REPO, path))}`);
    });
    expect(clashes).toEqual([]);
    expect(drawn).toEqual(expect.arrayContaining(["fr-root", "fr-columns", "fr-railsheet", "fr-stage"]));
  });

  it("reads a class out of a selector, not out of a value or a comment", () => {
    expect(
      [...classesStyledBy(`/* .fr-a */ .fr-b > .x:hover, a.y { width: .5rem; content: ".z" }`)].sort(),
    ).toEqual(["fr-b", "x", "y"]);
  });
});
