/** @vitest-environment jsdom */
/**
 * SETTINGS → TEXT SIZE: one key, five sizes, read before the first paint.
 *
 *  · the store reads the five sizes and nothing else, and a blocked jar is the default;
 *  · the browser stamp is `zoom` plus `--ui-zoom` on <html>, and the default size is the ABSENCE of both;
 *  · the web door's inline script, executed, writes exactly what the bundle's stamp writes —
 *    the pre-paint half and the live half cannot drift;
 *  · a host's door (the desktop's page zoom) replaces the stamp, and the row's press stores first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZES,
  TEXT_SIZE_KEY,
  UI_ZOOM_VAR,
  applyTextSize,
  installTextSizeApplier,
  readTextSize,
  stampTextSize,
  textSizeBootScript,
} from "../app/shell/text-size";
import { UI_ZOOM_VAR as UI_ZOOM_VAR_OF_UI, uiZoom } from "@ohmail/ui";

const root = (): HTMLElement => document.documentElement;
/* jsdom's style object DROPS `zoom` (it knows no such property), so the zoom half is read off the
   writes themselves; the custom property is kept and is read back for real. */
let zoomWritten = "";
const stamp = (): { zoom: string; ui: string } => ({
  zoom: zoomWritten,
  ui: root().style.getPropertyValue(UI_ZOOM_VAR),
});
const clear = (): void => {
  root().removeAttribute("style");
  zoomWritten = "";
};

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute("style");
  installTextSizeApplier(null);
  zoomWritten = "";
  const style = root().style;
  const set = style.setProperty.bind(style);
  const remove = style.removeProperty.bind(style);
  vi.spyOn(style, "setProperty").mockImplementation((name: string, value: string | null, prio?: string) => {
    if (name === "zoom") zoomWritten = value ?? "";
    set(name, value, prio);
  });
  vi.spyOn(style, "removeProperty").mockImplementation((name: string) => {
    if (name === "zoom") zoomWritten = "";
    return remove(name);
  });
});
afterEach(() => {
  installTextSizeApplier(null);
  vi.restoreAllMocks();
});

describe("the store", () => {
  it("reads the five sizes and defaults everything else", () => {
    expect([...TEXT_SIZES]).toEqual([90, 100, 110, 125, 150]);
    expect(readTextSize()).toBe(DEFAULT_TEXT_SIZE);
    for (const n of TEXT_SIZES) {
      localStorage.setItem(TEXT_SIZE_KEY, String(n));
      expect(readTextSize()).toBe(n);
    }
    for (const junk of ["", "95", "1.25", "125%", "abc", "-100", "1e2x"]) {
      localStorage.setItem(TEXT_SIZE_KEY, junk);
      expect(readTextSize(), junk).toBe(DEFAULT_TEXT_SIZE);
    }
  });

  it("a jar that throws reads as the default", () => {
    const blocked = { getItem: () => { throw new Error("SecurityError"); } } as unknown as Storage;
    expect(readTextSize(blocked)).toBe(DEFAULT_TEXT_SIZE);
  });
});

describe("the browser stamp", () => {
  it("is zoom and --ui-zoom on <html>, and 100% removes both", () => {
    stampTextSize(root(), 125);
    expect(stamp()).toEqual({ zoom: "1.25", ui: "1.25" });
    stampTextSize(root(), 100);
    expect(stamp()).toEqual({ zoom: "", ui: "" });
    expect(root().getAttribute("style") ?? "").toBe("");
  });

  it("writes the custom property the shared geometry reads", () => {
    expect(UI_ZOOM_VAR).toBe(UI_ZOOM_VAR_OF_UI);
    stampTextSize(root(), 150);
    expect(uiZoom()).toBe(1.5);
  });
});

describe("the web door's pre-paint script", () => {
  const run = (): void => {
    // eslint-disable-next-line no-new-func -- the inlined script, executed as the page runs it
    new Function(textSizeBootScript())();
  };

  it("writes what the stamp writes, for every size", () => {
    for (const n of TEXT_SIZES) {
      clear();
      localStorage.setItem(TEXT_SIZE_KEY, String(n));
      run();
      const fromScript = stamp();
      clear();
      stampTextSize(root(), n);
      expect(fromScript, `${n}%`).toEqual(stamp());
    }
  });

  it("stamps nothing for an empty jar, a foreign value or a jar that throws", () => {
    run();
    expect(stamp()).toEqual({ zoom: "", ui: "" });
    localStorage.setItem(TEXT_SIZE_KEY, "95");
    run();
    expect(stamp()).toEqual({ zoom: "", ui: "" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(run).not.toThrow();
    expect(stamp()).toEqual({ zoom: "", ui: "" });
  });
});

describe("the host's door", () => {
  it("the browser stamp is the default door", () => {
    applyTextSize(150);
    expect(stamp().zoom).toBe("1.5");
  });

  it("an installed door replaces the stamp entirely", () => {
    const taken: number[] = [];
    installTextSizeApplier((n) => taken.push(n));
    applyTextSize(110);
    expect(taken).toEqual([110]);
    expect(stamp()).toEqual({ zoom: "", ui: "" });
  });
  // The row's press (today's TextSizeRow, the General pane's) moved word for word to `text-size-row.test.ts`.
});
