/**
 * The settings half of the ohmarchy mapping (OHMARCHY-TOKENS.md §5), proven against the
 * LITERAL strings the Omarchy 4.0.2 VM answered — not against strings shaped like them:
 *
 *   fc-match -f '%{family}' monospace          "JetBrainsMono Nerd Font,JetBrainsMono NF"
 *   hyprctl getoption general:gaps_out -j      {"option": "general:gaps_out", "css": "10 10 10 10", "set": true }
 *   hyprctl getoption general:border_size -j   {"option": "general:border_size", "int": 2, "set": true }
 *   shell.toml                                  fixtures/shell.example.toml (the generated file, verbatim)
 *
 * And the degradation contract: every unreadable fact leaves its slots at the static
 * ohmarchy values — the overlay may only ever REPLACE a default with a known system fact,
 * never invent one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mapOmarchyTheme } from "../omarchy/map.js";
import { applySettings, parseSystem } from "../omarchy/settings.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = join(here, "..", "omarchy", "fixtures");
const tokyoNight = readFileSync(join(fixtures, "raw", "tokyo-night.colors.toml"), "utf8");
const shellToml = readFileSync(join(fixtures, "shell.example.toml"), "utf8");

/** The VM's literal answers (system.json's provenance). */
const VM = {
  fcMono: "JetBrainsMono Nerd Font,JetBrainsMono NF",
  gapsIn: '{"option": "general:gaps_in", "css": "5 5 5 5", "set": true }',
  gapsOut: '{"option": "general:gaps_out", "css": "10 10 10 10", "set": true }',
  border: '{"option": "general:border_size", "int": 2, "set": true }',
};

describe("parseSystem — the measured shapes", () => {
  it("reads the VM's own answers", () => {
    const s = parseSystem({
      fcMono: VM.fcMono,
      shellToml,
      hyprGapsIn: VM.gapsIn,
      hyprGapsOut: VM.gapsOut,
      hyprBorderSize: VM.border,
    });
    expect(s).toEqual({
      fontFamilies: ["JetBrainsMono Nerd Font", "JetBrainsMono NF"],
      fontSizePx: 12,
      gapsInPx: 5,
      gapsOutPx: 10,
      borderPx: 2,
    });
  });

  it("shell.example.toml's [font] base-size is found under its comment lines", () => {
    // The real generated file has comment lines between the header and the key; a reader
    // that only looked at the first line under [font] would answer null and the UI size
    // would silently stay static. (system.json: shell_base_size_px = 12.)
    expect(parseSystem({ shellToml }).fontSizePx).toBe(12);
  });

  it("answers nothing rather than guessing", () => {
    expect(parseSystem(null)).toEqual({
      fontFamilies: [],
      fontSizePx: null,
      gapsInPx: null,
      gapsOutPx: null,
      borderPx: null,
    });
    const garbage = parseSystem({
      fcMono: "",
      shellToml: "[bar]\nbase-size = 40\n", // right key, wrong section — not the UI size
      hyprGapsIn: "not json",
      hyprGapsOut: '{"option": "general:gaps_out"}', // answered, but valueless
      hyprBorderSize: '{"int": 400}', // past any real border — a corrupt read
    });
    expect(garbage).toEqual({
      fontFamilies: [],
      fontSizePx: null,
      gapsInPx: null,
      gapsOutPx: null,
      borderPx: null,
    });
  });

  it("strips what CSS must never see from a family name", () => {
    const s = parseSystem({ fcMono: `Bad"Font'\u0007,  Good  Font  ` });
    expect(s.fontFamilies).toEqual(["BadFont", "Good Font"]);
  });

  it("a family carrying structural punctuation drops ALONE - the stack survives it", () => {
    // The window fence bans slash, brackets and friends from whole values, so a family like
    // Mono/Code inside --font-ui would cost the entire declaration - every family, silently.
    // Refusing the one family here keeps the degradation per-ingredient. Weakening the fence
    // to quote-awareness instead of this refusal turns this into the guard that notices.
    const s = parseSystem({ fcMono: "Mono/Code,JetBrainsMono NF,Weird{Font}" });
    expect(s.fontFamilies).toEqual(["JetBrainsMono NF"]);
    // Balanced parens are REAL family punctuation (fc-list carries qualifiers like this) and
    // a balanced pair cannot restructure a rule — the fence passes them, so this must too.
    // A hanging paren is the fence's refusal, so it is this reader's refusal.
    expect(parseSystem({ fcMono: "Liberation Mono (TTF),Broken (Font" }).fontFamilies).toEqual([
      "Liberation Mono (TTF)",
    ]);
    const live = mapOmarchyTheme({
      colorsToml: tokyoNight,
      fcMono: "Mono/Code,JetBrainsMono NF",
    })!.tokens;
    expect(live["--font-ui"]).toBe(
      "'JetBrainsMono NF',ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace"
    );
  });
});

describe("applySettings — settings→token-slots (§5's table)", () => {
  const mappedWith = (system: Parameters<typeof parseSystem>[0]) =>
    mapOmarchyTheme({ colorsToml: tokyoNight, ...(system ?? {}) })!.tokens;

  it("the live system replaces exactly the six slots §5 names", () => {
    const untouched = mappedWith(null);
    const live = mappedWith({
      fcMono: VM.fcMono,
      shellToml,
      hyprGapsIn: VM.gapsIn,
      hyprGapsOut: VM.gapsOut,
      hyprBorderSize: VM.border,
    });
    expect(live["--font-ui"]).toBe(
      "'JetBrainsMono Nerd Font','JetBrainsMono NF',ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace",
    );
    expect(live["--font-size-base"]).toBe("12px");
    expect(live["--gap-tile"]).toBe("10px"); // gaps_in 5 × 2 — the rhythm between two tiles
    expect(live["--gap-edge"]).toBe("10px"); // gaps_out
    expect(live["--focus-w"]).toBe("2px"); // border_size
    // Everything else — the palette law's output — is untouched by the overlay.
    for (const [slot, value] of Object.entries(untouched)) {
      if (["--font-ui", "--font-size-base", "--gap-tile", "--gap-edge", "--focus-w"].includes(slot))
        continue;
      expect(live[slot], slot).toBe(value);
    }
  });

  it("a heavier window border widens the focus cursor AND the three tile rings — never lift-0", () => {
    const live = mappedWith({
      hyprBorderSize: '{"option": "general:border_size", "int": 4, "set": true }',
    });
    expect(live["--focus-w"]).toBe("4px");
    expect(live["--lift-1"].startsWith("0 0 0 4px ")).toBe(true);
    expect(live["--lift-2"].startsWith("0 0 0 4px ")).toBe(true);
    expect(live["--lift-3"].startsWith("0 0 0 4px ")).toBe(true);
    // lift-0 is shell.toml's own 1px control ring, not the window border.
    expect(live["--lift-0"].startsWith("0 0 0 1px ")).toBe(true);
  });

  it("a zero outer gap leaves the edge one ring wide, so the tiles' outer borders stay in the window", () => {
    // Owner report 2026-10-24: gaps_out read 0 drew the rail, list and reader flush to the
    // window, their rings outside it.
    const zero = '{"option": "general:gaps_out", "css": "0 0 0 0", "set": true }';
    expect(mappedWith({ hyprGapsIn: VM.gapsIn, hyprGapsOut: zero, hyprBorderSize: VM.border })["--gap-edge"]).toBe("2px");
    expect(mappedWith({ hyprGapsOut: zero, hyprBorderSize: '{"int": 4}' })["--gap-edge"]).toBe("4px");
    expect(mappedWith({ hyprGapsOut: zero })["--gap-edge"]).toBe("2px"); // the mapped ring
    expect(mappedWith({ hyprGapsOut: '{"css": "1 1 1 1"}', hyprBorderSize: '{"int": 0}' })["--gap-edge"]).toBe("2px");
  });

  it("with nothing known, the static theme rides unmodified", () => {
    const tokens = { "--font-ui": "x", "--lift-1": "0 0 0 2px red" };
    expect(applySettings(tokens, parseSystem(null))).toEqual(tokens);
  });
});
