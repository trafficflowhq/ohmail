/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * THE PANE-FOOT KEY HINT IS ONE AFFORDANCE, NOT A LEGEND.
 *
 * The strip under every list ("j k move · ↵ read · t tag · x select · u unread · ? all keys")
 * was set to one line with `overflow:hidden`, so a narrow pane — the split layout between
 * 900px and a wide desktop — CLIPPED it mid-word: "j k mo…" as permanent chrome. The multi-item
 * legend was also the hand-maintained second list of the bindings that the keyboard registry
 * exists to delete (`keymap.tsx`; the Screener's own strip had already been caught carrying a
 * key bound nowhere).
 *
 * Now the strip carries ONE item: `? shortcuts` — a button that presses the registry's `?`
 * binding, which opens the sheet GENERATED from the registry (`ShortcutSheet`). That content
 * cannot clip at any realistic pane width, and it cannot drift, because it documents exactly
 * one key and that key's job is to document the rest.
 *
 * MUTATION WATCH (each applied, watched go red, restored):
 *   · `flex-wrap: wrap` on `.list-hints` → "the strip cannot wrap".
 *   · legend span (`<Kbd>j</Kbd> … hintMove`) restored in OhboxView → "no hand-typed legend".
 *   · `onClick` wired to a local closure instead of `press("?")` → "the click is the keypress".
 *   · `chord: "u"` deleted from OhboxView → "the keys the legend taught are still bound".
 *   · literal `oklch(…)` color in shortcut-hint.css → "tokens only".
 */

/* ── the component under test ─────────────────────────────────────────────────────────── */

import { ShortcutHint } from "../app/shell/ShortcutHint";
import { KeymapProvider, useKeyBindings } from "../app/shell/keymap";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) {
    // Inside act: unmount runs the keymap layer's cleanup, which setStates the provider.
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

/** AppShell's `?` binding, in miniature: global scope, toggles the sheet. */
function SheetProbe({ onToggle }: { onToggle: () => void }) {
  useKeyBindings(
    [{ chord: "?", group: "app", label: "Keyboard shortcuts", run: onToggle }],
    "global",
  );
  return <ShortcutHint />;
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {ui}
      </NextIntlClientProvider>,
    );
  });
}

describe("ShortcutHint — the one item at the pane foot", () => {
  it("renders the ? keycap and the label, as a button", async () => {
    await mount(
      <KeymapProvider>
        <SheetProbe onToggle={() => {}} />
      </KeymapProvider>,
    );
    const btn = host!.querySelector("button.key-hint");
    expect(btn, "the affordance is missing").toBeTruthy();
    expect(btn!.querySelector("kbd")?.textContent).toBe("?");
    expect(btn!.textContent).toContain("shortcuts");
  });

  it("a click PRESSES the registry's ? binding — one code path with the key", async () => {
    // The assertion is that the click runs the binding REGISTERED for `?`, not a copy of its
    // handler: the probe's toggle is reachable only through the registry's press walk.
    let toggles = 0;
    await mount(
      <KeymapProvider>
        <SheetProbe onToggle={() => (toggles += 1)} />
      </KeymapProvider>,
    );
    const btn = host!.querySelector<HTMLButtonElement>("button.key-hint")!;
    await act(async () => btn.click());
    expect(toggles).toBe(1);
  });

  it("with no ? binding it renders NOTHING — never a guessed hint", async () => {
    // The `useBinding` rule (`keymap.tsx`): no registry, or no `?` in it, means no hint.
    await mount(
      <KeymapProvider>
        <ShortcutHint />
      </KeymapProvider>,
    );
    expect(host!.querySelector(".key-hint")).toBeNull();
  });

  it("it is ONE element in the strip — a strip holding it cannot need a second line", async () => {
    // The foot grew the GENERATED movement hints (ohmarchy Phase 1), but the strip still
    // holds exactly one child: the `.key-hints` wrapper, whose teaching tail carries the
    // truncation contract (`min-width:0` + ellipsis, asserted on the css below) while the
    // `?` affordance inside is `flex:none` and can never be the thing pushed off the line.
    await mount(
      <KeymapProvider>
        <div className="list-hints">
          <SheetProbe onToggle={() => {}} />
        </div>
      </KeymapProvider>,
    );
    const strip = host!.querySelector(".list-hints")!;
    expect(strip.children).toHaveLength(1);
    expect(strip.children[0]!.classList.contains("key-hints")).toBe(true);
    expect(strip.querySelector("button.key-hint")).toBeTruthy();
  });

  it("the movement hints are GENERATED — the enabled arrow winner's own label, never a typed one", async () => {
    // The dispatcher's rule, rendered: a disabled first declaration does not shadow the
    // enabled one below it (`useEnabledBinding` = the walk `onKey` takes), and a chord
    // nobody has enabled teaches nothing. Delete the ArrowDown binding and this goes red —
    // the mutation the hand-typed legend could never fail.
    function ArrowProbe() {
      useKeyBindings(
        [
          { chord: "ArrowDown", group: "navigate", label: "shadowed and disabled", disabled: true, run: () => {} },
          { chord: "ArrowDown", group: "navigate", label: "next message", run: () => {} },
        ],
        "global",
      );
      return null; // SheetProbe already renders the one foot under test
    }
    await mount(
      <KeymapProvider>
        <SheetProbe onToggle={() => {}} />
        <ArrowProbe />
      </KeymapProvider>,
    );
    const hints = host!.querySelectorAll(".key-hint-move");
    expect(hints).toHaveLength(1); // ↑↓ only — no lateral binding is enabled here
    expect(hints[0]!.textContent).toContain("next message");
    expect(hints[0]!.textContent).not.toContain("shadowed");
  });
});

/* ── the views carry the affordance and nothing else ──────────────────────────────────── */

const view = (name: string): string =>
  readFileSync(resolve(process.cwd(), `apps/webapp/app/views/${name}.tsx`), "utf8");

const VIEWS = {
  OhboxView: view("OhboxView"),
  ReadsView: view("ReadsView"),
  ReceiptsView: view("ReceiptsView"),
  ScreenerView: view("ScreenerView"),
} as const;

describe("every pane-foot strip is the affordance, not a legend", () => {
  it("the four views that had strips now render <ShortcutHint />", () => {
    // Ohbox and Screener through ListPane's `hints` slot; Reads and Receipts additionally in
    // their `.stream-hints` foot. Count them so a dropped one is named.
    const uses = Object.entries(VIEWS).map(
      ([name, src]) => [name, (src.match(/<ShortcutHint \/>/g) ?? []).length] as const,
    );
    expect(Object.fromEntries(uses)).toEqual({
      OhboxView: 1,
      ReadsView: 2,
      ReceiptsView: 2,
      ScreenerView: 1,
    });
  });

  it("no view hand-types a key legend again", () => {
    // `hintMove` was the lead item of every legend; any restored strip brings it back first.
    // The `?` sheet is the one list of the bindings — generated, so it cannot drift.
    for (const [name, src] of Object.entries(VIEWS)) {
      expect(src.includes("hintMove"), `${name} carries a hand-typed key legend again`).toBe(false);
      expect(src.includes("hintAllKeys"), `${name} still renders the old '? all keys' span`).toBe(false);
    }
  });

  it("the keys the legend used to teach are still BOUND in the Ohbox", () => {
    // The fix is display-only. j/k/↵/t/x/u remain declared bindings (the dispatcher and the
    // generated sheet both read them from `useKeyBindings`).
    for (const chord of ['"j"', '"k"', '"Enter"', '"t"', '"x"', '"u"']) {
      expect(
        VIEWS.OhboxView.includes(`chord: ${chord}`),
        `OhboxView no longer binds ${chord}`,
      ).toBe(true);
    }
  });
});

/* ── the strip's structure: one line at every width, on every theme ───────────────────── */

/** Comments stripped first — a commented-out declaration is not a declaration. */
const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const LIST_PANE = bare("packages/ui/src/composites/list-pane.css");
const STREAM = bare("packages/ui/src/composites/stream.css");
const HINT = bare("apps/webapp/app/shell/shortcut-hint.css");
const APP = bare("apps/webapp/app/app.css");
const TOUCH = bare("apps/webapp/app/shell/touch-keys.css");
const TOKENS = bare("packages/tokens/src/tokens.css");

/** The declarations of one selector's rule, media blocks included. */
const rule = (css: string, selector: string): string => {
  const re = new RegExp(`(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[2]! : "";
};

describe("the strip cannot wrap and cannot push the pane wider", () => {
  it(".list-hints stays a nowrap single line", () => {
    const r = rule(LIST_PANE, ".list-hints");
    expect(r, ".list-hints no longer declared in list-pane.css").not.toBe("");
    expect(r).toContain("flex-wrap:nowrap");
    expect(r).toContain("white-space:nowrap");
    expect(r).toContain("overflow:hidden");
  });

  it(".stream-hints stays a nowrap single line", () => {
    const r = rule(STREAM, ".stream-hints");
    expect(r, ".stream-hints no longer declared in stream.css").not.toBe("");
    expect(r).toContain("flex-wrap:nowrap");
    expect(r).toContain("white-space:nowrap");
    expect(r).toContain("overflow:hidden");
  });

  it("the affordance itself is nowrap", () => {
    const r = rule(HINT, ".key-hint");
    expect(r, ".key-hint no longer declared in shortcut-hint.css").not.toBe("");
    expect(r).toContain("white-space:nowrap");
  });

  it("under 700px the strips are gone entirely — no keyboard chrome over a phone's list", () => {
    // The declarations live inside app.css's `max-width: 699.98px` block; this scan does not
    // parse the at-rule, so their PRESENCE anywhere in the sheet is the guard: delete either
    // `display: none` and red.
    expect(APP).toMatch(/\.view \.list-hints \{\s*display: none;\s*\}/);
    expect(APP).toMatch(/\.view \.stream-hints \{\s*display: none;\s*\}/);
  });

  it("a coarse pointer hides the strips — a keycap on a keyboardless device is a lie", () => {
    // touch-keys.css's own rule ("key hints only where there are keys"), extended to the one
    // piece of keycap chrome it had not yet covered.
    const coarse = TOUCH.slice(TOUCH.indexOf("@media (pointer: coarse)"));
    expect(coarse).toContain(".view .list-hints");
    expect(coarse).toContain(".view .stream-hints");
  });
});

describe("both themes resolve the affordance", () => {
  it("shortcut-hint.css names no literal color — tokens only", () => {
    expect(HINT).not.toMatch(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(|hsl\(/);
  });

  it("every token it reads is defined for light AND dark", () => {
    const vars = [...new Set([...HINT.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!))];
    expect(vars.length, "no var() found — the affordance lost its token colors").toBeGreaterThan(0);
    for (const v of vars) {
      const defs = TOKENS.match(new RegExp(`${v}\\s*:`, "g")) ?? [];
      // Once in the light root and once per dark scope (`[data-theme="dark"]` and the
      // `prefers-color-scheme` block) — fewer than two means a theme where it inherits nothing.
      expect(defs.length, `${v} is not defined in both themes`).toBeGreaterThanOrEqual(2);
    }
  });
});
