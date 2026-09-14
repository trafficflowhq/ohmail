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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OMARCHY_FACE_ATTRIBUTE,
  OMARCHY_FACE_VALUE,
  OMARCHY_LIVE_ATTRIBUTE,
  OMARCHY_THEME_EVENT,
  applyOmarchyTokens,
  fencedTokens,
  omarchyRuleText,
  omarchySchemeSource,
  resetOmarchyFeedForTests,
  startOmarchyFeed,
  themeRawOfPayload,
} from "../src/omarchy.js";
/* The SAME module instance the feed reaches — the crossfade is one helper or it is two. */
import {
  armSchemeTransitions,
  resetSchemeTransitionsForTests,
} from "../../../packages/ui/src/theme/scheme-transition.js";

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

/** One of the 22 real themes, by slug — for the arm that needs a LIGHT one. */
const rawFixture = (slug: string): string => {
  const fromRoot = resolve(process.cwd(), "packages/tokens/omarchy/fixtures/raw");
  const dir = existsSync(fromRoot) ? fromRoot : resolve(process.cwd(), "../../packages/tokens/omarchy/fixtures/raw");
  return readFileSync(resolve(dir, `${slug}.colors.toml`), "utf8");
};

afterEach(() => {
  resetOmarchyFeedForTests();
  resetSchemeTransitionsForTests();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (document as unknown as Record<string, unknown>).startViewTransition;
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
    expect(rule).toContain("--panel: #1a1b26 !important;");
    expect(rule).toContain("--accent: #7aa2f7 !important;");
    expect(rule).toContain("color-scheme: dark !important;");
    expect(document.documentElement.getAttribute(OMARCHY_LIVE_ATTRIBUTE)).toBe("live");
  });

  /**
   * THE SCHEME AXIS SURVIVES THE FEED (control 1). Before this the live set was ONE unscoped
   * `:root[data-face="ohmarchy"]` rule, which outranks both static scheme blocks: the rail's
   * control moved `data-theme` and nothing on screen changed colour. The five forms below are
   * `packages/tokens/src/ohmarchy.css`'s own, so live and static agree by construction. The
   * COMPUTED values are not readable here — jsdom does not cascade custom properties out of
   * stylesheets — and are read in `scripts/scheme-under-ohmarchy-render.mjs`.
   */
  it("carries the five selector forms: its own scheme under auto and its own pair, the counterpart under the other", async () => {
    installShell({ slug: "tokyo-night", colorsToml: TOKYO_NIGHT });
    await startOmarchyFeed();
    const rule = styleText()!;
    const FACE = `:root[${OMARCHY_FACE_ATTRIBUTE}="${OMARCHY_FACE_VALUE}"]`;

    const forms = rule.split("\n").filter((l) => l.includes(FACE));
    expect(forms).toEqual([
      `${FACE}:not([data-theme="light"]):not([data-theme="dark"]) {`,
      `${FACE}[data-theme="dark"],`,
      `${FACE} [data-theme="dark"] {`,
      `${FACE}[data-theme="light"],`,
      `${FACE} [data-theme="light"] {`,
    ]);

    /* Each block carries its own `color-scheme`, and the counterpart's panel is a near-white
       derived from tokyo-night's own foreground — not flexoki-light's #FFFCF0, which is what
       the static block would have supplied. */
    const blocks = rule.split("}\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("color-scheme: dark !important;");
    expect(blocks[1]).toContain("--panel: #1a1b26 !important;");
    expect(blocks[2]).toContain("color-scheme: light !important;");
    expect(blocks[2]).toContain("--panel: #f8f9fc !important;");
    expect(blocks[2]).toContain("--ink: #1a1b26 !important;");
  });

  /** A theme whose counterpart misses a floor emits nothing for the other scheme, and the
   *  static face block for it stands — "keep what you have", never half-mapped. */
  it("no counterpart, no block — the static face keeps the other scheme", () => {
    const withCounterpart = omarchyRuleText({ "--panel": "#2e3440" }, "dark", {
      "--panel": "#fafafa",
    });
    const without = omarchyRuleText({ "--panel": "#2e3440" }, "dark", null);
    const schemeForms = (text: string): string[] =>
      text.split("\n").filter((l) => /^:root\[data-face="ohmarchy"\][ []/.test(l));
    expect(schemeForms(withCounterpart)).toHaveLength(4);
    expect(schemeForms(without)).toHaveLength(2);
    expect(schemeForms(without).join("\n")).not.toContain(`[data-theme="light"]`);
    expect(without.split("}\n")).toHaveLength(2);
  });

  /**
   * ONE PROVIDER OWNS THE STAMPS (control 9, OHMARCHY-CONTRACT.md). The feed writes CSS and
   * never an attribute: a `documentElement.dataset.theme = mode` here would be a second writer
   * racing `ThemeProvider`. `data-theme` appears in this module only inside selector text.
   */
  it("the feed writes no scheme attribute — selector text only", () => {
    /* From the repo root under the root vitest config, from the package under its own. */
    const fromRoot = resolve(process.cwd(), "apps/desktop/src/omarchy.ts");
    const path = existsSync(fromRoot) ? fromRoot : resolve(process.cwd(), "src/omarchy.ts");
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(/dataset\s*\.\s*theme/);
    expect(src).not.toMatch(/(set|remove|toggle)Attribute\(\s*["'`]data-theme/);
    /* The positive control that the needle above can fire at all: the module DOES write the
       live marker attribute, by exactly the spelling the scan looks for. */
    expect(src).toMatch(/setAttribute\(OMARCHY_LIVE_ATTRIBUTE/);
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

/**
 * WHAT "THE SYSTEM" IS ON THIS DESKTOP. Under the auto state the PAINT comes from the face's
 * no-explicit-theme rule, so this source changes no pixel — it exists so the scheme control's
 * sentence is true ("Auto (dark)") and so a press knows what it would hand back to.
 * `prefers-color-scheme` learns Omarchy's mode only through the GTK portal, and may not.
 */
describe("the scheme source the provider reads", () => {
  it("says nothing before the first payload, then the live theme's own mode, and notifies", async () => {
    expect(omarchySchemeSource.get()).toBeNull();
    const heard: (string | null)[] = [];
    const stop = omarchySchemeSource.subscribe(() => heard.push(omarchySchemeSource.get()));

    const { pushes } = installShell({ colorsToml: TOKYO_NIGHT });
    await startOmarchyFeed();
    expect(omarchySchemeSource.get()).toBe("dark");
    expect(heard).toEqual(["dark"]);

    /* `omarchy theme set` to a light theme while the window runs. */
    pushes.get(OMARCHY_THEME_EVENT)!({ payload: { colorsToml: rawFixture("catppuccin-latte") } });
    expect(omarchySchemeSource.get()).toBe("light");
    expect(heard).toEqual(["dark", "light"]);

    /* An unmappable payload keeps the standing answer, exactly as it keeps the standing set. */
    pushes.get(OMARCHY_THEME_EVENT)!({ payload: { colorsToml: "not a theme" } });
    expect(omarchySchemeSource.get()).toBe("light");
    expect(heard).toHaveLength(2);
    stop();
  });

  it("off-Omarchy it says nothing, and the provider falls back to the media query", async () => {
    installShell(null);
    await startOmarchyFeed();
    expect(omarchySchemeSource.get()).toBeNull();
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
    expect(afterNord).toContain("--panel: #2e3440 !important;");
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
    expect(rule).toContain("--font-size-base: 14px !important;");
    expect(rule).toContain("--font-ui: 'JetBrainsMono Nerd Font','JetBrainsMono NF',");
    expect(rule).toContain("--gap-tile: 10px !important;");
    expect(rule).toContain("--gap-edge: 10px !important;");
    expect(rule).toContain("--focus-w: 3px !important;");
    expect(rule).toContain("--lift-3: 0 0 0 3px #7aa2f7 !important;");
  });
});

/**
 * THE RESTAGE FADES (control 7). The feed's style write is the other change that repaints every
 * token at once — the first pull re-skins from the static defaults to the live theme, and
 * `omarchy theme set` restages the whole palette — and both were hard cuts. The write has to be
 * INSIDE the helper's callback: that callback is what the document is snapshotted around, so a
 * write beside it fades nothing and the cut comes back.
 */
describe("the live theme restages through the one crossfade", () => {
  it("the style is rewritten inside the transition's callback, not beside it", async () => {
    const { pushes } = installShell({ colorsToml: TOKYO_NIGHT });
    await startOmarchyFeed();
    const before = styleText()!;
    expect(before).toContain("#1a1b26");

    /* A view-transition API that HOLDS the callback, which is the only way to see which side
       of it the write is on. */
    let held: (() => void) | null = null;
    let calls = 0;
    (document as unknown as Record<string, unknown>).startViewTransition = (cb: () => void) => {
      calls += 1;
      held = cb;
      return { finished: Promise.resolve(), ready: Promise.resolve() };
    };
    armSchemeTransitions();

    pushes.get(OMARCHY_THEME_EVENT)!({ payload: { colorsToml: NORD_MINIMAL } });
    expect(calls, "the restage did not go through the crossfade").toBe(1);
    expect(styleText(), "the style was written OUTSIDE the transition").toBe(before);

    held!();
    expect(styleText()).toContain("#2e3440");
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

  it("a comment-opener or a hanging paren is dropped; a real rgba() wash is kept", () => {
    // A slash would open a comment that swallows every later declaration in the rule, and
    // CSS error recovery inside an unmatched `(` ignores `;` — either one costs the whole
    // theme, not one slot. Parens themselves are real: the tag washes are rgba() values.
    const pairs = fencedTokens({
      "--lift-2": "0 0 0 2px #4c566a /* eat the rest",
      "--hair": "rgba(169,177,214,0.25",
      "--tg-red-bg": "rgba(247,118,142,0.14)",
    });
    expect(pairs).toEqual([["--tg-red-bg", "rgba(247,118,142,0.14)"]]);
  });

  it("every emitted declaration carries the important flag — the live source outranks static tokens", () => {
    // The static follow-the-system dark block is (0,3,0) against this rule's (0,2,0); without
    // importance a dark desktop keeps the static values for every slot both define, and the
    // feed silently does nothing in the commonest configuration.
    applyOmarchyTokens({ "--panel": "#2e3440", "color-scheme": "dark" }, "dark", {
      "--panel": "#fafafa",
      "color-scheme": "light",
    });
    const rule = styleText()!;
    const declarations = rule.split("\n").filter((l) => l.startsWith("  "));
    expect(declarations).toHaveLength(6);
    for (const line of declarations) {
      expect(line.endsWith(" !important;"), line).toBe(true);
    }
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
