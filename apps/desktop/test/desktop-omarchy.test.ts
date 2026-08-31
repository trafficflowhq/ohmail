/** @vitest-environment jsdom */
/**
 * THE OMARCHY THEME FEED, driven rather than described.
 *
 * The window's half of §3c: the pull at start, the push when the desktop theme changes, the
 * mapped rule scoped to the ohmarchy face, and the two refusals that matter — material that
 * does not map KEEPS the standing set (never renders broken chrome), and a palette value
 * that could restructure the stylesheet is dropped at the fence. The payloads here are the
 * REAL shapes: a literal Omarchy 4.0.2 colors.toml and the VM's literal tool answers, not
 * strings shaped like them.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  OMARCHY_FACE_ATTRIBUTE,
  OMARCHY_FACE_VALUE,
  OMARCHY_LIVE_ATTRIBUTE,
  OMARCHY_THEME_EVENT,
  applyOmarchyTokens,
  fencedTokens,
  resetOmarchyFeedForTests,
  startOmarchyFeed,
  themeRawOfPayload,
} from "../src/omarchy.js";

/* The active theme the shell would read on a stock install — tokyo-night's real palette,
   inline so this suite (which the public mirror runs) carries its own ground truth. */
const TOKYO_NIGHT = [
  'mode = "dark"',
  'accent = "#7aa2f7"',
  'selection = "#292e42"',
  'muted = "#414868"',
  'background = "#1a1b26"',
  'dark_background = "#13141c"',
  'darker_background = "#0e0f14"',
  'lighter_background = "#292e42"',
  'foreground = "#a9b1d6"',
  'dark_foreground = "#565f89"',
  'light_foreground = "#c0caf5"',
  'bright_foreground = "#c0caf5"',
  'red = "#f7768e"',
  'yellow = "#e0af68"',
  'orange = "#ff9e64"',
  'green = "#9ece6a"',
  'cyan = "#7dcfff"',
  'blue = "#7aa2f7"',
  'magenta = "#bb9af7"',
  'brown = "#8c6c3e"',
  'bright_red = "#f7768e"',
  'bright_yellow = "#e0af68"',
  'bright_green = "#9ece6a"',
  'bright_cyan = "#7dcfff"',
  'bright_blue = "#7aa2f7"',
  'bright_magenta = "#bb9af7"',
].join("\n");

const NORD_MINIMAL = [
  'mode = "dark"',
  'accent = "#81a1c1"',
  'muted = "#4c566a"',
  'background = "#2e3440"',
  'foreground = "#d8dee9"',
  'dark_foreground = "#667080"',
  'red = "#bf616a"',
].join("\n");

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

type Push = (payload: unknown) => void;

/** The shell, faked at the same seam every desktop test fakes it. */
function installShell(themeAnswer: unknown): { asked: Asked[]; pushes: Map<string, Push> } {
  const asked: Asked[] = [];
  const callbacks = new Map<number, Push>();
  const pushes = new Map<string, Push>();
  let nextId = 1;
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback(cb: Push) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    async invoke(command: string, payload?: Record<string, unknown>) {
      asked.push({ command, payload });
      if (command === "plugin:event|listen") {
        const handler = callbacks.get(payload?.handler as number);
        if (handler) pushes.set(payload?.event as string, handler);
        return null;
      }
      if (command === "omarchy_theme") return themeAnswer;
      throw new Error(`unexpected command ${command}`);
    },
  };
  return { asked, pushes };
}

const styleText = () => document.getElementById("ohmail-omarchy-live")?.textContent ?? null;

afterEach(() => {
  resetOmarchyFeedForTests();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the feed's start", () => {
  it("listens for the push, pulls the current theme, and applies it scoped to the face", async () => {
    const { asked, pushes } = installShell({ slug: "tokyo-night", colorsToml: TOKYO_NIGHT });
    await startOmarchyFeed();

    expect(asked.map((a) => a.command)).toEqual(["plugin:event|listen", "omarchy_theme"]);
    expect(pushes.has(OMARCHY_THEME_EVENT)).toBe(true);

    const rule = styleText();
    expect(rule).not.toBeNull();
    expect(rule).toContain(`:root[${OMARCHY_FACE_ATTRIBUTE}="${OMARCHY_FACE_VALUE}"]`);
    expect(rule).toContain("--panel: #1a1b26;");
    expect(rule).toContain("--accent: #7aa2f7;");
    expect(rule).toContain("color-scheme: dark;");
    expect(document.documentElement.getAttribute(OMARCHY_LIVE_ATTRIBUTE)).toBe("live");
  });

  it("off-Omarchy — a null answer — applies nothing and marks nothing", async () => {
    installShell(null);
    await startOmarchyFeed();
    expect(styleText()).toBeNull();
    expect(document.documentElement.getAttribute(OMARCHY_LIVE_ATTRIBUTE)).toBeNull();
  });

  it("outside the shell it is silence, not an error", async () => {
    await startOmarchyFeed();
    expect(styleText()).toBeNull();
  });
});

describe("the push — omarchy theme set, heard live", () => {
  it("a pushed restage re-skins; unmappable material keeps the standing set", async () => {
    const { pushes } = installShell({ slug: "tokyo-night", colorsToml: TOKYO_NIGHT });
    await startOmarchyFeed();
    const push = pushes.get(OMARCHY_THEME_EVENT)!;

    // The real event arrives enveloped; the switch to nord must land in the rule.
    push({ event: OMARCHY_THEME_EVENT, payload: { slug: "nord", colorsToml: NORD_MINIMAL } });
    const afterNord = styleText();
    expect(afterNord).toContain("--panel: #2e3440;");
    expect(afterNord).not.toContain("#1a1b26");

    // A half-staged or broken theme: the LAST GOOD set stands, byte for byte.
    push({ payload: { slug: "broken", colorsToml: "not a theme" } });
    push({ payload: { slug: "broken" } });
    push("garbage");
    expect(styleText()).toBe(afterNord);
  });

  it("the system's own settings ride the same payload into their slots", async () => {
    const { pushes } = installShell(null);
    await startOmarchyFeed();
    pushes.get(OMARCHY_THEME_EVENT)!({
      payload: {
        colorsToml: TOKYO_NIGHT,
        shellToml: "[font]\n# the generated file's comment lines\nbase-size = 14\n",
        fcMono: "JetBrainsMono Nerd Font,JetBrainsMono NF",
        hyprGapsIn: '{"option": "general:gaps_in", "css": "5 5 5 5", "set": true }',
        hyprGapsOut: '{"option": "general:gaps_out", "css": "10 10 10 10", "set": true }',
        hyprBorderSize: '{"option": "general:border_size", "int": 3, "set": true }',
      },
    });
    const rule = styleText()!;
    expect(rule).toContain("--font-size-base: 14px;");
    expect(rule).toContain("--font-ui: 'JetBrainsMono Nerd Font','JetBrainsMono NF',");
    expect(rule).toContain("--gap-tile: 10px;");
    expect(rule).toContain("--gap-edge: 10px;");
    expect(rule).toContain("--focus-w: 3px;");
    expect(rule).toContain("--lift-3: 0 0 0 3px #7aa2f7;");
  });
});

describe("the fence", () => {
  it("a palette value that could restructure the stylesheet is dropped, not escaped", () => {
    // `muted` crosses the law verbatim into --lift-2 — the one place a theme author's text
    // reaches CSS unparsed. A closing brace in it must never reach the style element.
    const hostile = NORD_MINIMAL.replace(
      'muted = "#4c566a"',
      'muted = "#4c566a} :root { background: hotpink !important }"',
    );
    applyOmarchyTokens({ "--panel": "#2e3440" });
    const before = styleText()!;
    expect(before).toContain("--panel");

    const raw = themeRawOfPayload({ colorsToml: hostile });
    expect(raw).not.toBeNull();
    // The mapped set for the hostile palette: everything survives EXCEPT the poisoned slot.
    const pairs = fencedTokens({
      "--lift-2": "0 0 0 2px #4c566a} :root { background: hotpink !important }",
      "--panel": "#2e3440",
      "not-a-token": "#fff",
      "--too-big": "x".repeat(600),
    });
    expect(pairs).toEqual([["--panel", "#2e3440"]]);
  });

  it("the payload validator refuses every non-theme shape", () => {
    expect(themeRawOfPayload(null)).toBeNull();
    expect(themeRawOfPayload(42)).toBeNull();
    expect(themeRawOfPayload({})).toBeNull();
    expect(themeRawOfPayload({ colorsToml: "" })).toBeNull();
    expect(themeRawOfPayload({ colorsToml: "x".repeat(256 * 1024 + 1) })).toBeNull();
    // Optional ingredients degrade alone — a numeric fcMono is not a family list, and the
    // theme still maps.
    const raw = themeRawOfPayload({ colorsToml: TOKYO_NIGHT, fcMono: 7 });
    expect(raw).not.toBeNull();
    expect(raw!.fcMono).toBeNull();
  });
});
