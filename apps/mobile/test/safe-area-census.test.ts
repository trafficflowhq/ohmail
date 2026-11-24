/**
 * ═══ EVERY ROUTE'S TOP STRIP CLEARS THE STATUS BAR ══════════════════════════════════════════
 *
 * The door chooser drew its header with a fixed `paddingTop: 28` and no safe-area inset, so on
 * an iPhone the wordmark sat on the OS clock at every launch. The signed-in chrome was already
 * correct — `TopBar` and `DetailBar` both pay `insets.top` — which is exactly why nobody saw it:
 * the one route that renders NEITHER bar was the one route with no inset.
 *
 * So the rule is structural rather than per-screen: a route either hands its header to the
 * chrome, or it reads {@link useTopPad}. A fourth route added next week is covered the day it
 * lands rather than the day somebody launches it on a notched phone.
 *
 * The arithmetic itself is driven at a real inset below (59 px, an iPhone 14 Pro's), because a
 * census can only say WHERE the number comes from and never what it is.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ────────────────────────────────────────
 *
 *  · `paddingTop: top` → `paddingTop: 28` in `app/welcome.tsx`   ⇒ "every route" RED.
 *  · `topPad` returns `gap` instead of `insetTop + gap`           ⇒ "59 px" RED.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { topPad } from "../src/ui/safe-area";

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROUTES = join(APP, "app");

/** Every route file under `app/`, by relative path — `_layout.tsx` included (it draws too). */
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name.endsWith(".tsx")) out.push(relative(ROUTES, full));
  }
  return out;
}

/**
 * The two layout files draw no strip of their own: `app/_layout.tsx` mounts the providers and the
 * stack, `app/(tabs)/_layout.tsx` the tab bar (whose own inset is the BOTTOM one, paid by
 * `Scroller`). Named rather than inferred from "has no paddingTop", which would exempt the very
 * defect this census exists for.
 */
const NO_TOP_STRIP = new Set(["_layout.tsx", join("(tabs)", "_layout.tsx")]);

/**
 * Routes whose WHOLE BODY is a `src/ui` component — the two-pane surfaces mount the same body
 * beside a list, so the reading views moved there and the top strip moved with them. Named,
 * not inferred: the census asserts the route still MOUNTS its carrier and then follows the
 * strip into the carrier's source. A delegation this table does not know is still a refusal.
 */
const BODY_CARRIERS: Record<string, { component: string; file: string }> = {
  "welcome.tsx": { component: "OnboardingPage", file: "src/ui/OnboardingPage.tsx" },
  "standalone.tsx": { component: "OnboardingPage", file: "src/ui/OnboardingPage.tsx" },
  "scan.tsx": { component: "OnboardingPage", file: "src/ui/OnboardingPage.tsx" },
  "connect.tsx": { component: "OnboardingPage", file: "src/ui/OnboardingPage.tsx" },
  [join("message", "[id].tsx")]: { component: "MessageReader", file: "src/ui/MessageReader.tsx" },
  [join("sender", "[seg]", "[id].tsx")]: { component: "SenderDetail", file: "src/ui/SenderDetail.tsx" },
  [join("trash", "[id].tsx")]: { component: "TrashReader", file: "src/ui/TrashReader.tsx" },
  [join("drafts", "[id].tsx")]: { component: "DraftReader", file: "src/ui/DraftReader.tsx" },
};

const routes = routeFiles(ROUTES);
const body = (p: string) => readFileSync(join(ROUTES, p), "utf8");

/**
 * Does the inset REACH a `paddingTop`, rather than merely being asked for?
 *
 * The first draft of this census tested for a `useTopPad(` call, and reverting the chooser's
 * `paddingTop` to the fixed 28 kept it GREEN: the call was still there, its result unused. A
 * census satisfied by a symbol appearing passes for a file that ignores it — so the binding is
 * followed to the property it has to land on.
 */
function insetReachesTheTop(src: string): boolean {
  if (/paddingTop:\s*useTopPad\s*\(/.test(src)) return true;
  const bound = /const\s+(\w+)\s*=\s*useTopPad\s*\(/.exec(src);
  if (!bound) return false;
  return new RegExp(`paddingTop:\\s*${bound[1]}\\b`).test(src);
}

describe("the top of every route clears the OS status bar", () => {
  it("the route list is not empty and holds the door chooser", () => {
    // A census whose glob has gone stale is a census that passes for nothing.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain("welcome.tsx");
  });

  for (const route of routes) {
    if (NO_TOP_STRIP.has(route)) continue;
    it(`app/${route} takes its top inset from the chrome or from useTopPad`, () => {
      const src = body(route);
      const carrier = BODY_CARRIERS[route];
      if (carrier !== undefined) {
        expect(src.includes(`<${carrier.component}`),
          `app/${route} no longer mounts ${carrier.file} — move it out of BODY_CARRIERS`).toBe(true);
        const inner = readFileSync(join(APP, carrier.file), "utf8");
        expect(/<(?:TopBar|DetailBar)\b/.test(inner) || insetReachesTheTop(inner),
          `${carrier.file} draws a top strip with no safe-area inset`).toBe(true);
        return;
      }
      const bar = /<(?:TopBar|DetailBar)\b/.test(src);
      expect(bar || insetReachesTheTop(src),
        `app/${route} draws a top strip with no safe-area inset`).toBe(true);
    });
  }

  /**
   * THE SHELL'S OWN TOP STRIP, which is in no route file: `ui/Gated.tsx` mounts it ABOVE every
   * gated screen, so whenever it draws it is the first thing under the status bar — outside the
   * chrome that pays the inset everywhere else. MEASURED ON A DEVICE (2026-09-20, Android
   * emulator): with a fixed `marginTop: 8` its first line sat against the clock and the panel's
   * top corners were clipped by the screen edge — the chooser's defect one flight further in,
   * and invisible to the route census above. It pushes the PANEL down, so the inset lands on a
   * margin rather than a padding; EVERY margin in the file must read the one helper, because the
   * component has two panels and fixing one leaves the other under the bar.
   */
  it("src/ui/LifecycleStrip.tsx clears the status bar, in both its panels", () => {
    const src = readFileSync(join(APP, "src/ui/LifecycleStrip.tsx"), "utf8");
    const bound = /const\s+(\w+)\s*=\s*useTopPad\s*\(/.exec(src);
    expect(bound, "the strip does not read useTopPad at all").not.toBeNull();
    const margins = src.match(/marginTop:\s*[^,\n]+/g) ?? [];
    expect(margins.length, "no marginTop left to check — has the strip stopped drawing?")
      .toBeGreaterThan(1);
    for (const m of margins) {
      expect(m, `${m} does not read the inset`).toMatch(
        new RegExp(`useTopPad\\(|:\\s*${bound![1]}\\b`),
      );
    }
    expect(/insets\.top/.test(src), "the strip re-spells the top inset").toBe(false);
  });

  it("both chrome bars and the bar-less pane top read the ONE helper — no second spelling of the arithmetic", () => {
    const chrome = readFileSync(join(APP, "src/ui/chrome.tsx"), "utf8");
    // Three strips, three calls: TopBar, DetailBar and PaneTop. A strip that went back to
    // `insets.top + n` would be a second place the arithmetic lives, which is how the chooser's
    // copy of it drifted in the first place.
    expect(chrome.match(/useTopPad\s*\(/g) ?? []).toHaveLength(3);
    expect(insetReachesTheTop(chrome), "a chrome bar asks for the inset and ignores it").toBe(true);
    expect(chrome.match(/paddingTop:\s*top\b/g) ?? []).toHaveLength(3);
    expect(/insets\.top/.test(chrome), "chrome.tsx re-spells the top inset").toBe(false);
  });
});

describe("topPad — driven at a real inset", () => {
  /** iPhone 14 Pro portrait. The number the defect was measured on. */
  const INSET = 59;

  it("a 59 px inset puts the chooser's header below the clock, not on it", () => {
    expect(topPad(INSET, 28)).toBe(87);
    expect(topPad(INSET, 28)).toBeGreaterThanOrEqual(INSET);
  });

  it("the chrome bars clear it too, at their own smaller gap", () => {
    expect(topPad(INSET, 6)).toBeGreaterThanOrEqual(INSET);
  });

  it("a phone with no inset keeps the design's gap exactly", () => {
    // An Android device with the status bar drawn outside the window reports 0, and the chooser
    // must still sit 28 px down rather than flush against the top edge.
    expect(topPad(0, 28)).toBe(28);
  });
});
