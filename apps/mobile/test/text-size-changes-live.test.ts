/**
 * A SYSTEM TEXT-SIZE CHANGE RE-LAYS THE OPEN SCREEN IN PLACE (on iOS and on Android).
 *
 * iOS re-measured nothing after a live change: React's next commit handed back shadow nodes measured
 * at the old size, so the letter's subject, Back and the action bar were cut and the Ohbox rows kept
 * their heights. Android recreated the activity and dropped the open letter and the composer. The
 * text half: a probe line's height moves, the theme's `textCap` flips and every text host carries
 * it, so each node gets new props and is measured again. The Android half: the plugin keeps the
 * activity across `fontScale` and `density`.
 */
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const rig = vi.hoisted(() => ({
  scale: undefined as unknown,
  setters: [] as ((u: unknown) => void)[],
  /* The posture provider's text epoch, read through the theme's one context. */
  epoch: 0,
}));

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (init && typeof init === "object" && "generation" in init) {
        if (rig.scale === undefined) rig.scale = init;
        const set = (u: unknown) => {
          rig.scale = typeof u === "function" ? (u as (p: unknown) => unknown)(rig.scale) : u;
        };
        return [rig.scale, set];
      }
      return [init, () => {}];
    },
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useEffect: () => {},
    useContext: () => rig.epoch,
  };
});
vi.mock("react-native", () => ({
  AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  Text: "Text",
  useColorScheme: () => "light",
}));

import { ThemeProvider, type Theme } from "../src/theme";
import { FIRST_READING, readProbe, textCapOf } from "../src/theme/text-scale";
import { type as typePresets } from "../src/theme/type";

type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === "object" && "props" in node) { out.push(node as El); walk((node as El).props.children, out); }
  return out;
}

/** One render of the real provider at the rig's current reading: its theme and its probe line. */
function renderTheme(): { theme: Theme; probe: El } {
  const tree = walk(ThemeProvider({ pref: "system", children: null }));
  const theme = tree.find((e) => "value" in e.props)!.props.value as Theme;
  const probe = tree.find((e) => e.type === "Text")!;
  return { theme, probe };
}
const layout = (probe: El, height: number) =>
  (probe.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 90, height } } });

describe("a live text-size change re-measures every text node", () => {
  it("the probe's height moving flips the cap every text host carries, and nothing else does", () => {
    rig.scale = undefined;
    const first = renderTheme();
    expect(first.probe.props.style).toEqual([typePresets.h1, { position: "absolute", top: 0, left: 0, opacity: 0 }]);
    expect(first.probe.props.maxFontSizeMultiplier).toBe(first.theme.textCap);

    layout(first.probe, 77); // the first layout records the size, it is not a change
    const settled = renderTheme();
    expect(settled.theme.textCap).toBe(first.theme.textCap);
    layout(settled.probe, 77.3); // rounding, not a new size
    expect(renderTheme().theme.textCap).toBe(first.theme.textCap);

    layout(settled.probe, 104); // the person moved the slider: Large -> XXXL
    const grown = renderTheme();
    expect(grown.theme.textCap).not.toBe(first.theme.textCap);
    expect(grown.probe.props.maxFontSizeMultiplier).toBe(grown.theme.textCap);

    layout(grown.probe, 77); // and back: the cap moves again, so shrinking re-measures too
    expect(renderTheme().theme.textCap).not.toBe(grown.theme.textCap);
  });

  it("a stale layout after the change still ends on fresh nodes, and the cap never binds", () => {
    let r = readProbe(FIRST_READING, 77);
    const caps = [textCapOf(r.generation)];
    for (const h of [104, 77, 104]) { r = readProbe(r, h); caps.push(textCapOf(r.generation)); }
    for (let i = 1; i < caps.length; i++) expect(caps[i]).not.toBe(caps[i - 1]);
    expect(readProbe(r, 104)).toBe(r);
    expect(readProbe(r, 0)).toBe(r);
    // iOS's largest accessibility size is 3.571, Android's largest font scale 2.0.
    for (let g = 0; g < 4; g++) expect(textCapOf(g)).toBeGreaterThan(3.571);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsxUnder(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/** Every `<Text …>` / `<TextInput …>` / `<Animated.Text …>` opening tag, as `file:line` and its attributes. */
function textHosts(src: string): { line: number; tag: string }[] {
  const s = withoutComments(src);
  const out: { line: number; tag: string }[] = [];
  for (const m of s.matchAll(/<(Text|TextInput|Animated\.Text)(?=[\s/>])/g)) {
    if (/[\w$.]/.test(s[m.index! - 1] ?? "")) continue; // `useRef<TextInput>` is a type argument
    let depth = 0;
    let quote = "";
    let j = m.index! + m[0].length;
    for (; j < s.length; j++) {
      const c = s[j]!;
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (depth === 0 && c === ">") break;
    }
    out.push({ line: s.slice(0, m.index).split("\n").length, tag: s.slice(m.index, j + 1) });
  }
  return out;
}
const CAP = /\bmaxFontSizeMultiplier=\{(t\.textCap|textCap)\}/;
/* A Text also carries the measurement key: the cap alone is not part of the cache's key. */
const KEY = /\bminimumFontScale=\{(t\.textKey|textKey)\}/;
/** One cap attribute, the theme's, and no spread after it that could hand a caller's value in. */
const carries = (tag: string): boolean => {
  const at = tag.search(CAP);
  return at >= 0 && (tag.match(/\bmaxFontSizeMultiplier=/g) ?? []).length === 1 && !tag.slice(at).includes("{...");
};

describe("a density or text-size change re-measures every text node too", () => {
  it("the epoch moving moves the cap, whatever the probe read", () => {
    rig.scale = undefined; rig.epoch = 0;
    const before = renderTheme();
    rig.epoch = 1;
    const after = renderTheme();
    expect(after.theme.textCap).not.toBe(before.theme.textCap);
    expect(after.probe.props.maxFontSizeMultiplier).toBe(after.theme.textCap);
    rig.epoch = 0;
  });
});

describe("every text host carries the theme's cap", () => {
  it("in every screen and component of the app", () => {
    const files = [...tsxUnder(join(ROOT, "src")), ...tsxUnder(join(ROOT, "app"))];
    const hosts = files.flatMap((f) => textHosts(readFileSync(f, "utf8")).map((h) => ({ ...h, at: `${relative(ROOT, f)}:${h.line}` })));
    // Anti-vacuity: the app draws text through these sites; a moved directory would read zero.
    expect(hosts.length).toBeGreaterThan(20);
    const bare = hosts.filter((h) => !carries(h.tag)).map((h) => h.at);
    expect(bare, "a text host without maxFontSizeMultiplier={t.textCap} keeps its old size after a live change").toEqual([]);
    const texts = hosts.filter((h) => !h.tag.startsWith("<TextInput"));
    expect(texts.length, "the Text hosts, apart from the inputs").toBeGreaterThan(5);
    const unkeyed = texts.filter((h) => !KEY.test(h.tag) || (h.tag.match(/\bminimumFontScale=/g) ?? []).length !== 1).map((h) => h.at);
    expect(unkeyed, "a Text without minimumFontScale={t.textKey} is read back from the measurement cache").toEqual([]);
  });

  it("the census reads a bare host as bare and admits a carrying one", () => {
    const fixture = [
      "const A = () => <Text style={[t.type.body, { color: x > 1 ? a : b }]}>{s}</Text>;",
      "const B = () => <TextInput value={v} onChangeText={(x) => set(x)} maxFontSizeMultiplier={t.textCap} />;",
      "// <Text>in a comment</Text>",
      "const r = useRef<TextInput>(null);",
      "const C = () => <TextInput maxFontSizeMultiplier={t.textCap} maxFontSizeMultiplier={undefined} />;",
      "const D = () => <Text maxFontSizeMultiplier={t.textCap} {...rest} />;",
      "const E = () => <Text {...rest} maxFontSizeMultiplier={t.textCap} />;",
    ].join("\n");
    const hosts = textHosts(fixture);
    expect(hosts.map((h) => [h.line, carries(h.tag)])).toEqual([[1, false], [2, true], [5, false], [6, false], [7, true]]);
  });
});

/* Android's landscape IME takes the whole screen for a bare field unless the input opts out (no-op on
   iOS); iOS draws a light keyboard under a Dark app unless the input names the theme's scheme. */
const holds = (tag: string, prop: RegExp): boolean => {
  const at = tag.search(prop);
  return at >= 0 && !tag.slice(at).includes("{...");
};
const inPlace = (tag: string): boolean => holds(tag, /\bdisableFullscreenUI(?=[\s/>])/);
const keyboardInScheme = (tag: string): boolean => holds(tag, /\bkeyboardAppearance=\{t\.scheme\}/);

describe("every text input stays in place under the keyboard, in the app's scheme", () => {
  const files = [...tsxUnder(join(ROOT, "src")), ...tsxUnder(join(ROOT, "app"))];
  const inputs = files.flatMap((f) => textHosts(readFileSync(f, "utf8")).filter((h) => h.tag.startsWith("<TextInput"))
    .map((h) => ({ ...h, at: `${relative(ROOT, f)}:${h.line}` })));

  it("no input hands the screen to Android's full-screen editor", () => {
    expect(inputs.length).toBeGreaterThan(8);
    expect(inputs.filter((h) => !inPlace(h.tag)).map((h) => h.at)).toEqual([]);
  });

  it("every input opens the iOS keyboard in the theme's scheme", () => {
    expect(inputs.filter((h) => !keyboardInScheme(h.tag)).map((h) => h.at)).toEqual([]);
  });

  it("the census reads a bare input as bare and admits one in place", () => {
    const hosts = textHosts([
      "const A = () => <TextInput value={v} />;",
      "const B = () => <TextInput disableFullscreenUI value={v} />;",
      "const C = () => <TextInput disableFullscreenUI {...rest} />;",
      "const D = () => <TextInput disableFullscreenUIX />;",
    ].join("\n"));
    expect(hosts.map((h) => inPlace(h.tag))).toEqual([false, true, false, false]);
  });

  it("the census admits only the theme's scheme, never a literal or a spread after it", () => {
    const hosts = textHosts([
      "const A = () => <TextInput value={v} />;",
      "const B = () => <TextInput keyboardAppearance={t.scheme} value={v} />;",
      'const C = () => <TextInput keyboardAppearance="dark" />;',
      "const D = () => <TextInput keyboardAppearance={t.scheme} {...rest} />;",
      "const E = () => <TextInput keyboardAppearance={t.schemeX} />;",
    ].join("\n"));
    expect(hosts.map((h) => keyboardInScheme(h.tag))).toEqual([false, true, false, false, false]);
  });
});

describe("a display-size change re-opens every dialog at the new density", () => {
  it("every Modal is keyed on the window scale", () => {
    const files = [...tsxUnder(join(ROOT, "src")), ...tsxUnder(join(ROOT, "app"))];
    const modals = files.flatMap((f) => {
      const s = withoutComments(readFileSync(f, "utf8"));
      return [...s.matchAll(/<Modal\b[^>]*>/g)].map((m) => ({ at: `${relative(ROOT, f)}`, tag: m[0] }));
    });
    expect(modals.length).toBeGreaterThan(1);
    expect(modals.filter((m) => !/\bkey=\{modalKey\}/.test(m.tag)).map((m) => m.at)).toEqual([]);
    const sheet = withoutComments(readFileSync(join(ROOT, "src/ui/Sheet.tsx"), "utf8"));
    expect(sheet).toMatch(/useModalKey\(\): string \{\s*return `density-\$\{useWindowDimensions\(\)\.scale\}`;/);
  });
});

const req = createRequire(import.meta.url);
const plugin = req(join(ROOT, "plugins/live-text-size.js")) as {
  configChangesWith: (v: string | undefined) => string;
  keepActivityOnTextSize: (m: unknown) => { manifest: { application: { activity: { $: Record<string, string> }[] }[] } };
};

/** The template's own line, read off this tree's generated `AndroidManifest.xml` (expo 57.0.9). */
const TEMPLATE_CONFIG_CHANGES =
  "keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths";

describe("Android keeps the activity across a font-size or display-size change", () => {
  it("the generated main activity declares fontScale and density beside the template's values", () => {
    const manifest = {
      manifest: {
        application: [{
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity", "android:configChanges": TEMPLATE_CONFIG_CHANGES } }],
        }],
      },
    };
    const out = plugin.keepActivityOnTextSize(manifest).manifest.application[0]!.activity[0]!.$["android:configChanges"]!;
    const values = out.split("|");
    for (const v of TEMPLATE_CONFIG_CHANGES.split("|")) expect(values).toContain(v);
    expect(values).toContain("fontScale");
    expect(values).toContain("density");
    expect(plugin.configChangesWith(out)).toBe(out);
  });

  it("app.json runs it, before the backup plugin that must stay last", () => {
    const app = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8")) as { expo: { plugins: unknown[] } };
    const names = app.expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain("./plugins/live-text-size");
    expect(names[names.length - 1]).toBe("./plugins/backup-exclusions");
  });
});
