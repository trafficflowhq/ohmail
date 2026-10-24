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

  it("reads every gaps_out shape hyprctl answers, per side, and keeps the narrowest", () => {
    const out = (raw: string) => parseSystem({ hyprGapsOut: raw }).gapsOutPx;
    expect(out('{"option": "general:gaps_out", "int": 12, "set": true }')).toBe(12);
    expect(out('{"option": "general:gaps_out", "css": "10 10 10 10", "set": true }\n')).toBe(10);
    expect(out('{"option": "general:gaps_out", "custom": "10 10 10 10", "set": true }')).toBe(10);
    expect(out('{"css": "8"}')).toBe(8);
    expect(out('{"css": "6 10"}')).toBe(6);
    expect(out('{"css": "10 7 12"}')).toBe(7);
    expect(out('{"css": "10 10 10 4"}')).toBe(4); // the first side alone read 10
    expect(out('{"css": "0 10 10 10"}')).toBe(0);
    for (const bad of ['{"css": "10 x 10 10"}', '{"css": "1 2 3 4 5"}', '{"css": "-5 10 10 10"}', '{"css": ""}', "no such option"])
      expect(out(bad), bad).toBeNull();
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
    // Box gaps: gaps_in 5 × 2 between the two 2px rings, gaps_out 10 to the ring's outer edge.
    expect(live["--gap-tile"]).toBe("14px");
    expect(live["--gap-edge"]).toBe("12px");
    expect(live["--gap-rail"]).toBe("12px"); // one ring and the tile gap's 10, beside the squares' rail
    expect(live["--focus-w"]).toBe("2px"); // border_size
    // Everything else — the palette law's output — is untouched by the overlay.
    for (const [slot, value] of Object.entries(untouched)) {
      if (["--font-ui", "--font-size-base", "--gap-tile", "--gap-edge", "--gap-rail", "--focus-w"].includes(slot))
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
    // The heavier rings stand in the gaps, which keep 10 between and around them.
    expect([live["--gap-tile"], live["--gap-edge"], live["--gap-rail"]]).toEqual(["18px", "14px", "14px"]);
  });

  it("the edge is never narrower than the tile gap, whatever gaps_out reads", () => {
    // Owner reports 2026-10-24/25: gaps_out read 0 drew the columns flush to the window, then
    // one ring off it; the design's frame is the even gap between the tiles.
    const edge = (system: Parameters<typeof parseSystem>[0]) => mappedWith(system)["--gap-edge"];
    const zero = '{"option": "general:gaps_out", "css": "0 0 0 0", "set": true }';
    // Each edge is the visible gap plus the 2px ring standing outside the tile's box.
    expect(edge({ hyprGapsIn: VM.gapsIn, hyprGapsOut: zero, hyprBorderSize: VM.border })).toBe("12px");
    expect(edge({ hyprGapsOut: zero })).toBe("12px"); // the static tile gap
    expect(edge({ hyprGapsIn: VM.gapsIn, hyprGapsOut: '{"css": "0 10 10 10"}' })).toBe("12px");
    expect(edge({ hyprGapsIn: VM.gapsIn, hyprGapsOut: '{"css": "5 10 15 20"}' })).toBe("12px");
    expect(edge({ hyprGapsIn: VM.gapsIn, hyprGapsOut: '{"css": "4 4 4 4"}' })).toBe("12px");
    expect(edge({ hyprGapsIn: '{"css": "8 8 8 8"}', hyprGapsOut: VM.gapsOut })).toBe("18px");
    expect(edge({ hyprGapsIn: '{"css": "8 8 8 8"}' })).toBe("18px"); // gaps_out unread
    expect(edge({ hyprGapsIn: VM.gapsIn, hyprGapsOut: '{"css": "20 20 20 20"}' })).toBe("22px");
    // The rail beside a tile keeps the tile gap, not the edge's.
    expect(mappedWith({ hyprGapsIn: VM.gapsIn, hyprGapsOut: '{"css": "20 20 20 20"}' })["--gap-rail"]).toBe("12px");
    expect(mappedWith({ hyprGapsIn: '{"css": "8 8 8 8"}', hyprGapsOut: VM.gapsOut })["--gap-rail"]).toBe("18px");
  });

  it("Omarchy's no-gaps toggle keeps the design gap around and between the tiles", () => {
    // omarchy-hyprland-window-gaps-toggle: gaps_in 0, gaps_out 0, border_size 0.
    const zero = '{"css": "0 0 0 0"}';
    const gaps = (system: Parameters<typeof parseSystem>[0]) => {
      const t = mappedWith(system);
      return [t["--gap-tile"], t["--gap-edge"]];
    };
    // 10 between and around the rings: box gaps of 10 + 2 rings and 10 + 1 ring.
    expect(gaps({ hyprGapsIn: zero, hyprGapsOut: zero, hyprBorderSize: '{"int": 0}' })).toEqual(["14px", "12px"]);
    expect(gaps({ hyprGapsIn: zero, hyprGapsOut: zero, hyprBorderSize: VM.border })).toEqual(["14px", "12px"]);
    expect(gaps({ hyprGapsIn: zero, hyprGapsOut: zero })).toEqual(["14px", "12px"]);
    expect(gaps({ hyprGapsIn: '{"css": "2 2 2 2"}', hyprGapsOut: '{"css": "1 1 1 1"}' })).toEqual(["14px", "12px"]);
    expect(gaps({ hyprGapsIn: zero, hyprGapsOut: zero, hyprBorderSize: '{"int": 12}' })).toEqual(["34px", "22px"]);
  });

  it("with nothing known, the static theme rides unmodified", () => {
    const tokens = { "--font-ui": "x", "--lift-1": "0 0 0 2px red" };
    expect(applySettings(tokens, parseSystem(null))).toEqual(tokens);
  });
});
