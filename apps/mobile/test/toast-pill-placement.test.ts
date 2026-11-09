/**
 * WHERE THE PILL STANDS. Measured on the iPhone 18 Pro: the pill drew,
 * seconds late, at a fixed 74pt over the inset — the dock's height — which in the reader put
 * "Parked · Undo" across the Later and Park capsules of a two-row verb bar. Held here: the MOUNT
 * (one `<Toast />`, last at the root, an absolute sibling of the navigator and the rail, inside
 * the chrome provider, outside every modal subtree); the GEOMETRY (for every posture preset the
 * pill lies inside the window and clears what the plan puts at the foot, with the pre-fix
 * constant driven as the case that fails on the 18 Pro); the REPORTERS (the dock and the
 * reader's bar each hold a slot fed from `onLayout`, because a bar knows its height only there).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { POSTURE_PRESETS, derivePosture, type PostureInput } from "../src/ui/posture/derive";
import { scaffoldPlan } from "../src/ui/scaffold/plan";
import { readerPaneWidth, readerVerbMode } from "../src/ui/reader-verbs";
import { TOAST_FLOOR, TOAST_GAP, foldSlots, tallest, toastBottom, toastFrame } from "../src/ui/bottom-chrome";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const LAYOUT = path.join(APP, "app", "_layout.tsx");
const DOCK = path.join(APP, "src", "ui", "glass", "GlassDock.tsx");
const READER_BAR = path.join(APP, "src", "ui", "MessageActions.tsx");

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const tagOf = (n: ts.Node): string | null =>
  ts.isJsxSelfClosingElement(n) ? n.tagName.getText()
    : ts.isJsxElement(n) ? n.openingElement.tagName.getText()
    : null;

const hasAttr = (n: ts.Node, name: string): boolean => {
  const attrs = ts.isJsxSelfClosingElement(n) ? n.attributes
    : ts.isJsxElement(n) ? n.openingElement.attributes
    : null;
  return attrs !== null && attrs.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
};

function jsxNodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node) => { if (tagOf(n) !== null) out.push(n); ts.forEachChild(n, walk); };
  walk(sf);
  return out;
}

const walkTsx = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walkTsx(p) : d.name.endsWith(".tsx") ? [p] : [];
  });

/* ── 1. the mount ─────────────────────────────────────────────────────────────────────────── */

describe("the pill is mounted once, at the root, last, outside every modal subtree", () => {
  const sf = parse(LAYOUT);
  const toasts = jsxNodes(sf).filter((n) => tagOf(n) === "Toast");

  it("exactly one <Toast /> in the whole app, and it is in the root layout", () => {
    expect(toasts).toHaveLength(1);
    const elsewhere = [...walkTsx(path.join(APP, "app")), ...walkTsx(path.join(APP, "src"))]
      .filter((f) => f !== LAYOUT)
      .filter((f) => jsxNodes(parse(f)).some((n) => tagOf(n) === "Toast"));
    expect(elsewhere, "a second mount would be two pills").toEqual([]);
  });

  it("its parent is the bottom-chrome provider, no ancestor is a modal, and it comes after the navigator and the rail", () => {
    const toast = toasts[0]!;
    const parents: ts.Node[] = [];
    for (let p: ts.Node | undefined = toast.parent; p; p = p.parent) if (tagOf(p) !== null) parents.push(p);
    expect(parents.map(tagOf)[0]).toBe("BottomChromeProvider");
    expect(parents.some((p) => hasAttr(p, "accessibilityViewIsModal"))).toBe(false);
    const parent = parents[0] as ts.JsxElement;
    const siblings = parent.children.map(tagOf).filter((t): t is string => t !== null);
    expect(siblings.indexOf("Toast")).toBe(siblings.length - 1);
    /* The navigator and the rail stand under the shell's error boundary now, so "after" is read
       as source order among the provider's DESCENDANTS, each present exactly once — the pill
       still draws over both. It stands OUTSIDE that boundary: a fallback must not take the pill. */
    const posOf = (tag: string): number => {
      const hits: number[] = [];
      const walk = (n: ts.Node) => { if (tagOf(n) === tag) hits.push(n.getStart()); ts.forEachChild(n, walk); };
      walk(parent);
      expect(hits, `${tag} under the chrome provider`).toHaveLength(1);
      return hits[0]!;
    };
    expect(posOf("NavRail")).toBeGreaterThan(posOf("Stack"));
    expect(posOf("Toast")).toBeGreaterThan(posOf("NavRail"));
    expect(parents.map(tagOf)).not.toContain("SurfaceBoundary");
  });

  it("the pill itself is an absolute, box-none view with the toast layer — it draws over, never blocks", () => {
    const chrome = parse(path.join(APP, "src", "ui", "chrome.tsx"));
    const pill = jsxNodes(chrome).filter((n) => tagOf(n) === "Animated.View" && hasAttr(n, "accessibilityLiveRegion"));
    expect(pill).toHaveLength(1);
    const text = pill[0]!.getText();
    expect(text).toContain('position: "absolute"');
    expect(text).toContain('pointerEvents="box-none"');
    expect(text).toContain("zIndex: t.zLayer.toast");
    expect(text).toContain("toastBottom(insets.bottom, chrome)");
  });

  /* The hold counts from the SCREEN: everything one JS task commits is mounted at the task's end,
     so a timer armed at the commit can expire before the pill is drawn ("Undone." did, on the
     18 Pro). The dismiss timer lives in the layout handler, the view is keyed per entry so that
     handler fires for every sentence, and the effect arms no timer of its own. */
  it("the hold timer is armed in onLayout, once per keyed entry — never in the effect — and the layout is reported to the gate", () => {
    const sf = parse(path.join(APP, "src", "ui", "chrome.tsx"));
    // Each slot's pill holds its own entry since the Undo offer keeps its slot (`ToastPill`).
    let toastFn: ts.FunctionDeclaration | null = null;
    ts.forEachChild(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === "ToastPill") toastFn = n; });
    expect(toastFn).not.toBeNull();
    const body = (toastFn as unknown as ts.FunctionDeclaration).body!;
    const timers = (n: ts.Node): ts.CallExpression[] => {
      const out: ts.CallExpression[] = [];
      const walk = (m: ts.Node) => {
        if (ts.isCallExpression(m) && m.expression.getText() === "setTimeout") out.push(m);
        ts.forEachChild(m, walk);
      };
      walk(n);
      return out;
    };
    let layoutHandler: ts.Node | null = null;
    let effectBody: ts.Node | null = null;
    body.statements.forEach((s) => {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === "laidOut" && d.initializer) layoutHandler = d.initializer;
        }
      }
      if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText() === "useEffect") {
        effectBody = s.expression.arguments[0]!;
      }
    });
    expect(layoutHandler, "the layout handler `laidOut`").not.toBeNull();
    expect(effectBody, "the effect").not.toBeNull();
    const armed = timers(layoutHandler!);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.getText()).toContain("dismiss(toastId)");
    expect(armed[0]!.getText()).toContain("holdMs");
    expect(timers(effectBody!)).toHaveLength(0);
    // The report that releases a waiting door (`toast-one.ts#paintGate`), from the same handler.
    expect((layoutHandler as unknown as ts.Node).getText()).toContain("onScreen()");
    const pill = jsxNodes(sf).filter((n) => tagOf(n) === "Animated.View" && hasAttr(n, "accessibilityLiveRegion"))[0]!;
    const attrs = (pill as ts.JsxElement).openingElement.attributes.properties
      .filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p))
      .map((p) => [p.name.getText(), p.initializer?.getText() ?? ""] as const);
    expect(attrs).toContainEqual(["key", "{toastId}"]);
    expect(attrs).toContainEqual(["onLayout", "{laidOut}"]);
  });
});

/* ── 2. the geometry ──────────────────────────────────────────────────────────────────────── */

/** The 18 Pro in points (1206×2622 @3x), Dynamic Island top, home indicator bottom. */
const PRO18 = { window: { width: 402, height: 874 }, insets: { top: 62, bottom: 34 } };
/** Measured on the device: the reader's two-row compact bar, foot included (34 + 136). */
const PRO18_READER_BAR = 170;
const PILL_H = 40;

const postureOf = (name: string) => {
  const p = POSTURE_PRESETS[name];
  if (!p) throw new Error(`no preset ${name}`);
  const input: PostureInput = {
    platform: p.platform ?? "ios", width: p.width, height: p.height, folds: p.folds ?? null,
    hasFold: p.hasFold, isPad: p.isPad, windowBounds: p.windowBounds ?? null,
  };
  return { posture: derivePosture(input), platform: input.platform, width: p.width, height: p.height };
};

/** What the plan puts at the foot, as the extent each reporter would send. */
function footOf(name: string, insetBottom: number, barHeight: number): { chrome: string; extent: number } {
  const { posture, platform, width, height } = postureOf(name);
  const plan = scaffoldPlan(posture, platform);
  const mode = readerVerbMode(plan, readerPaneWidth(posture, plan, { w: width, h: height }, { left: 0, right: 0 }, true));
  if (mode === "compact") return { chrome: "compact bar", extent: Math.max(insetBottom, 8) + barHeight };
  if (mode === "bar") return { chrome: "action bar", extent: Math.max(insetBottom, 12) + barHeight };
  if (plan.nav === "dock") return { chrome: "dock", extent: Math.max(insetBottom, 10) + 56 };
  return { chrome: "nothing", extent: 0 };
}

describe("the pill's frame on the 18 Pro", () => {
  it("clears the reader's two-row bar and stays inside the window", () => {
    const f = toastFrame(PRO18.window, PRO18.insets, PRO18_READER_BAR, PILL_H);
    expect(f.bottom).toBeGreaterThan(PRO18_READER_BAR);
    expect(f.bottom - PRO18_READER_BAR).toBe(TOAST_GAP);
    expect(f.top).toBeGreaterThanOrEqual(PRO18.insets.top);
    expect(f.left).toBeGreaterThanOrEqual(0);
    expect(f.right).toBeLessThanOrEqual(PRO18.window.width);
  });

  it("the pre-fix constant fails the same question — the measured defect, as arithmetic", () => {
    // 34 + 74 = 108 from the foot, against a bar reaching 170: the pill's bottom edge sat 62pt
    // INSIDE the bar, which is the frame where "Out of Parked · Undo" covered Later and Park.
    expect(PRO18.insets.bottom + TOAST_FLOOR).toBeLessThan(PRO18_READER_BAR);
  });

  it("over the dock the pill keeps its shipped position — the floor is the dock's own clearance", () => {
    const dock = Math.max(PRO18.insets.bottom, 10) + 56;
    expect(toastBottom(PRO18.insets.bottom, dock)).toBe(PRO18.insets.bottom + TOAST_FLOOR);
  });
});

describe("every posture preset: the pill lies inside the window and above what stands at the foot", () => {
  for (const name of Object.keys(POSTURE_PRESETS)) {
    it(name, () => {
      const { width, height } = postureOf(name);
      const insets = { top: 24, bottom: 20 };
      // A bar can be one row or, wrapped, two — sweep what the reporters could plausibly send.
      for (const barHeight of [48, 96, 136, 160]) {
        const foot = footOf(name, insets.bottom, barHeight);
        const f = toastFrame({ width, height }, insets, foot.extent, PILL_H);
        expect(f.bottom, `${name}: below the ${foot.chrome} at ${barHeight}`).toBeGreaterThan(foot.extent);
        expect(f.top, `${name}: over the top inset`).toBeGreaterThanOrEqual(insets.top);
        expect(f.right - f.left, `${name}: has width`).toBeGreaterThan(0);
      }
    });
  }
});

describe("the slots fold", () => {
  it("the tallest wins, a leaver clears its own slot, an unchanged report is the same object", () => {
    let s = foldSlots({}, "dock", 90);
    s = foldSlots(s, "reader-bar", 170);
    expect(tallest(s)).toBe(170);
    expect(foldSlots(s, "reader-bar", 170)).toBe(s);
    s = foldSlots(s, "reader-bar", null);
    expect(tallest(s)).toBe(90);
    expect(foldSlots(s, "reader-bar", null)).toBe(s);
    expect(tallest(foldSlots(s, "dock", null))).toBe(0);
  });
});

/* ── 3. the reporters ─────────────────────────────────────────────────────────────────────── */

/** The slot's variable name, and every `onLayout` that feeds it. */
function reporters(file: string): { slot: string | null; feeds: number } {
  const sf = parse(file);
  let slot: string | null = null;
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
      && n.initializer.expression.getText() === "useBottomChromeSlot" && ts.isIdentifier(n.name)) slot = n.name.text;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (slot === null) return { slot, feeds: 0 };
  const feeds = jsxNodes(sf).filter((n) => {
    const attrs = ts.isJsxSelfClosingElement(n) ? n.attributes : (n as ts.JsxElement).openingElement.attributes;
    return attrs.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "onLayout"
      && p.initializer !== undefined && p.initializer.getText().includes(`${slot}(`));
  }).length;
  return { slot, feeds };
}

describe("the surfaces at the foot report their extent from layout", () => {
  it("the dock holds a slot and feeds it from onLayout", () => {
    expect(reporters(DOCK)).toEqual({ slot: "standing", feeds: 1 });
  });
  it("the reader's bar holds a slot and feeds it from both of its shapes (compact, ActionBar)", () => {
    expect(reporters(READER_BAR)).toEqual({ slot: "standing", feeds: 2 });
  });
});
