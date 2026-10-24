/**
 * THE 0.25.23 FORM-FACTOR FINDINGS (.. R5-07), as the laws that decide them. Each case
 * drives the function the screen renders with; the wiring of each into its component is read off the
 * component's code. The device readings are the lane's own AVD and simulator frames.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { derivePosture, type FoldFeature } from "../src/ui/posture/derive";
import { RAIL_W, listNavClearance, scaffoldPlan, screenHingeClearance, screenRailClearance } from "../src/ui/scaffold/plan";
import { TOAST_SIDE, toastFrame, toastSpan } from "../src/ui/bottom-chrome";
import { IPAD_WINDOW_CONTROLS_PT, topInsetWithControls } from "../src/ui/window-controls";
import { TEXT_CAP_FLOOR, textCapOf, textEpochOf, textKeyOf } from "../src/theme/text-scale";

const ROOT = join(__dirname, "..");
const code = (rel: string): string => withoutComments(readFileSync(join(ROOT, rel), "utf8"));
const fold = (x: number, h: number, state: "flat" | "half"): FoldFeature =>
  ({ bounds: { x, y: 0, w: 0, h }, state, orientation: "vertical", occlusion: "none" });
const android = (width: number, height: number, folds: FoldFeature[] | null) =>
  derivePosture({ width, height, platform: "android", folds, hasFold: folds !== null });

describe("R5-05: a screen with no navigation drawn pays no rail", () => {
  /* The foldable's inner screen at 718 dp, flat: two panes, the leading rail. */
  const plan = scaffoldPlan(android(718, 897, [fold(359, 897, "flat")]), "android");

  it("the connect flow (nothing drawn) is centred; a mailbox's screens clear the rail", () => {
    expect(plan.nav).toBe("rail");
    expect(screenRailClearance(plan, true, false, false)).toEqual({ left: 0, right: 0 });
    expect(screenRailClearance(plan, true, false, true).left, "the positive control").toBe(RAIL_W + plan.gutter);
    expect(screenRailClearance(plan, true).left, "unsaid, the navigation is drawn").toBe(RAIL_W + plan.gutter);
  });

  it("a list in the connect flow clears neither the rail nor the dock", () => {
    expect(listNavClearance(plan, 90, false)).toEqual({ bottom: 0, left: 0, right: 0 });
    const phone = scaffoldPlan(android(411, 891, null), "android");
    expect(listNavClearance(phone, 90, false)).toEqual({ bottom: 0, left: 0, right: 0 });
    expect(listNavClearance(phone, 90).bottom, "the dock's clearance once a mailbox is open").toBe(90);
  });

  it("the root decides once, and the rail, every Screen and every list read that one decision", () => {
    expect(code("app/_layout.tsx")).toMatch(/<NavDrawnContext\.Provider value=\{navDrawn\}>/);
    const base = code("src/ui/base.tsx");
    expect(base).toContain("screenRailClearance(plan, fills, inPane, useNavDrawn())");
    expect(base).toContain("listNavClearance(plan, t.space.tabClearance, useNavDrawn())");
    expect(code("src/ui/nav-rail.tsx")).toContain("if (!drawn) return null;");
  });
});

describe("R5-06: the list heads wrap Mark all read instead of running it off the screen", () => {
  it("the row wraps and the control keeps to the trailing edge, shrinking on a line of its own", () => {
    const m = code("src/ui/MarkAllRead.tsx");
    expect(m).toMatch(/VIEW_HEAD_ROW = \{ flexDirection: "row", alignItems: "center", flexWrap: "wrap"/);
    expect(m).toMatch(/marginLeft: "auto",\s*flexShrink: 1,\s*maxWidth: "100%"/);
  });

  for (const route of ["app/(tabs)/index.tsx", "app/(tabs)/reads.tsx"]) {
    it(`${route}: the head is the wrapping row, with no spacer that would hold the control on the title's line`, () => {
      const s = code(route);
      const head = s.slice(s.indexOf("<View style={VIEW_HEAD_ROW}>"));
      expect(head.length, "the head renders the shared row").toBeLessThan(s.length);
      const row = head.slice(0, head.indexOf("<MarkAllRead"));
      expect(row).not.toContain("flex: 1");
    });
  }
});

describe("R5-07: the toast keeps to the reading side of a book fold", () => {
  for (const [w, h] of [[674, 841], [718, 897], [580, 760]] as const) {
    it(`book at ${w} dp: the pill starts past the crease; flat it spans the window`, () => {
      const book = android(w, h, [fold(w / 2, h, "half")]);
      const clear = screenHingeClearance(book, scaffoldPlan(book, "android"), true, false, w);
      const f = toastFrame({ width: w, height: h }, { top: 24, bottom: 20 }, 0, 40, clear);
      expect(f.left).toBeGreaterThan(w / 2);
      expect(f.right).toBe(w - TOAST_SIDE);
      const flat = android(w, h, [fold(w / 2, h, "flat")]);
      const none = screenHingeClearance(flat, scaffoldPlan(flat, "android"), true, false, w);
      expect(toastSpan(none), "a flat fold has no width").toEqual({ left: TOAST_SIDE, right: TOAST_SIDE });
    });
  }

  it("the pill is placed by that span", () => {
    const s = code("src/ui/chrome.tsx");
    expect(s).toMatch(/const span = toastSpan\(\s*screenHingeClearance\(posture, scaffoldPlan\(posture,/);
    expect(s).toMatch(/left: span\.left,\s*right: span\.right,/);
  });
});

describe("R5-04: an iPad window clears its controls where the system says they end", () => {
  const pad = { isPad: true, screen: { width: 820, height: 1180 } };
  const slideOver = { ...pad, window: { width: 375, height: 1100 } };
  const full = { ...pad, window: { width: 820, height: 1180 } };

  it("the system's reading wins over the frame strip, in every window shape", () => {
    expect(topInsetWithControls(0, slideOver, 68)).toBe(68);
    expect(topInsetWithControls(24, slideOver, 68)).toBe(68);
    expect(topInsetWithControls(24, full, 24), "a full window whose controls sit in the inset").toBe(24);
    expect(topInsetWithControls(24, full, 74)).toBe(74);
    expect(topInsetWithControls(30, full, 12), "never under the system's own inset").toBe(30);
  });

  /* R6-08: resizable windows at 375 and 695 pt read only the status bar; the list head sat under the controls. */
  it("on a windowed iPad a reading short of the strip is taken as the strip", () => {
    for (const width of [375, 695]) {
      const win = { ...pad, window: { width, height: 1180 } };
      expect(topInsetWithControls(24, win, 24), `${width} pt`).toBe(24 + IPAD_WINDOW_CONTROLS_PT);
      expect(topInsetWithControls(0, win, 0), `${width} pt`).toBe(IPAD_WINDOW_CONTROLS_PT);
      expect(topInsetWithControls(24, win, IPAD_WINDOW_CONTROLS_PT), "a reading at the strip stands").toBe(IPAD_WINDOW_CONTROLS_PT);
    }
  });

  it("without a reading, a windowed iPad keeps the frame strip and a phone is untouched", () => {
    expect(topInsetWithControls(24, slideOver, null)).toBe(24 + IPAD_WINDOW_CONTROLS_PT);
    expect(topInsetWithControls(24, full, null)).toBe(24);
    expect(topInsetWithControls(47, { ...slideOver, isPad: false }, 120)).toBe(47);
  });

  it("the provider reads the native region on every window change, and the module reads the adapted safe area", () => {
    const p = code("src/ui/posture/index.tsx");
    expect(p).toContain("const posture = isPad ? nativePosture() : null;");
    expect(p).toMatch(/\}, \[isPad, dims\.width, dims\.height, insets\.top\]\);/);
    expect(p).toContain("}, controlsTop);");
    const swift = code("modules/ohmail-posture/ios/OhmailPostureModule.swift");
    expect(swift).toContain(".edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top");
  });
});

describe("R5-01 and R5-03: every text node is measured again after a text-size or density change", () => {
  it("the cap takes a new value for every generation, so two changes never land on the one the nodes carry", () => {
    const caps = [0, 1, 2, 3, 4].map(textCapOf);
    expect(new Set(caps).size).toBe(caps.length);
    expect(textCapOf(2), "two changes in one render: a flip by parity would read the cap the nodes carry").not.toBe(textCapOf(0));
    for (const c of caps) expect(c).toBeGreaterThanOrEqual(TEXT_CAP_FLOOR);
  });

  it("the measurement key moves with every generation, further apart than the cache's tolerance, and never binds", () => {
    for (let g = 0; g < 60; g++) {
      expect(Math.abs(textKeyOf(g + 1) - textKeyOf(g)), `${g}`).toBeGreaterThanOrEqual(0.0099);
      expect(textKeyOf(g)).toBeGreaterThan(0);
      expect(textKeyOf(g)).toBeLessThanOrEqual(1);
    }
    expect(new Set(Array.from({ length: 50 }, (_, g) => textKeyOf(g))).size).toBe(50);
  });

  it("the epoch moves on a density or a text-size change and on nothing else", () => {
    const at = { scale: 2.4625, fontScale: 1 };
    expect(textEpochOf(3, at, { ...at })).toBe(3);
    expect(textEpochOf(3, at, { ...at, scale: 2 })).toBe(4);
    expect(textEpochOf(3, at, { ...at, fontScale: 1.3 })).toBe(4);
  });

  it("the theme's cap is the probe's generation plus the epoch", () => {
    const theme = code("src/theme/index.tsx");
    expect(theme).toContain("const textGeneration = scale.generation + useTextEpoch();");
    expect(theme).toContain("const textCap = textCapOf(textGeneration);");
    expect(theme).toContain("const textKey = textKeyOf(textGeneration);");
  });


  it("the native relayout has every native stack screen send its frame again, in the density it now has", () => {
    const kt = code("modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt");
    const fn = kt.slice(kt.indexOf('Function("relayoutRoot")'), kt.indexOf('AsyncFunction("showKeyboardWhenFocused")'));
    expect(fn).toMatch(/if \(screens && v is Screen && v\.isAttachedToWindow && v\.container is ScreenStack && !v\.usesFormSheetPresentation\(\)\) \{\s*v\.updateState\(v\.width, v\.height, v\.top\)/);
    /* asked for the screens only when the density moved */
    const p = code("src/ui/posture/index.tsx");
    expect(p).toContain("const densityMoved = relaidScale.current !== dims.scale;");
    expect(p).toContain("nativePosture()?.relayoutRoot?.(densityMoved);");
    /* the walk goes on into the root's children, where the screens are */
    expect(fn).not.toMatch(/v\.requestLayout\(\)\s*continue/);
    expect(code("modules/ohmail-posture/android/build.gradle")).toContain('compileOnly project(":react-native-screens")');
  });
});

describe("R5-02: the keyboard comes back once the redrawn dialog has input focus", () => {
  it("the request waits for the window's focus and is made for the field still holding the caret", () => {
    const kt = code("modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt");
    const fn = kt.slice(kt.indexOf('AsyncFunction("showKeyboardWhenFocused")'));
    expect(fn).toMatch(/if \(view\.hasWindowFocus\(\)\) \{\s*askForKeyboard\(view, 0\)/);
    expect(fn).toContain("addOnWindowFocusChangeListener");
    expect(fn).toMatch(/if \(!hasFocus\) return/);
    const ask = kt.slice(kt.indexOf("private fun askForKeyboard"), kt.indexOf("class OhmailPostureModule"));
    expect(ask).toMatch(/if \(!view\.isAttachedToWindow \|\| !view\.isFocused \|\| !view\.hasWindowFocus\(\)\) return/);
    expect(ask).toContain("showSoftInput(view, 0)");
    expect(ask, "asked again only while the window reads the keyboard as down").toMatch(/isVisible\(WindowInsets\.Type\.ime\(\)\) != true\) askForKeyboard\(view, attempt \+ 1\)/);
  });

  it("every native door is called on the module, never read off it and called bare", () => {
    expect(code("src/ui/keyboard-native.ts")).toContain("posture.showKeyboardWhenFocused(tag)");
    const p = code("src/ui/posture/index.tsx");
    expect(p).toContain("posture.getWindowControlsInset().then(");
    expect(p).toContain("posture.refreshTextScale().then(");
    for (const f of ["src/ui/keyboard-native.ts", "src/ui/posture/index.tsx"]) {
      expect(code(f), f).not.toMatch(/const \w+ = (?:isPad \? )?nativePosture\(\)\?\.\w+(?: : undefined)?;/);
    }
  });

  it("the composer asks for it after it gives the caret back", () => {
    expect(code("src/ui/MessageActions.tsx")).toContain("useFocusKeeper(Date.now, showKeyboardWhenFocused)");
  });
});
