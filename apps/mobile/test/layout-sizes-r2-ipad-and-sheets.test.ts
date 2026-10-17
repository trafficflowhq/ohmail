/**
 * the phone and iPad half: four findings, each read where it is decided.
 *
 *  · a sheet rises in the window UNDER the status bar: the room's own top padding is the
 *    inset, so a keyboard-high reply sheet at Accessibility sizes stops below the clock.
 *  · on an iPad window smaller than its screen (Split View, Slide Over, a free window)
 *    the window controls are top inset for every reader of the safe area.
 *  · on an iPad every sentence names an iPad; "iPhone" is another word.
 *  · iOS Settings → New mail names no UnifiedPush distributor.
 *
 * MUTATIONS WATCHED: `paddingTop` dropped from `sheetRoom`; `windowedOnPad` answering false; the deck's
 * getter returning the deck string unread; the iOS arm of `wakeSentence` removed — each RED.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({
  isPad: true, window: { width: 405, height: 1180 }, screen: { width: 820, height: 1180 }, controlsTop: null as number | null,
}));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  /* The provider's one state is the system's reading of the controls (null until read). */
  return { ...real, useMemo: (f: () => unknown) => f(), useState: (init: unknown) => [init === null ? rig.controlsTop : init, () => {}], useEffect: () => {} };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios", get isPad() { return rig.isPad; } },
  View: "View",
  Dimensions: { get: () => rig.screen },
  useWindowDimensions: () => rig.window,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaInsetsContext: { Provider: "InsetsProvider" },
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 20, left: 0 }),
}));
vi.mock("../src/ui/posture/posture-native", () => ({ nativePosture: () => null }));
vi.mock("../src/engine/engine-log", () => ({ logPostureDerived: () => {} }));

import { sheetRoom } from "../src/ui/sheet-bounds";
import { IPAD_WINDOW_CONTROLS_PT, topInsetWithControls, windowedOnPad } from "../src/ui/window-controls";
import { WindowControlsInsets } from "../src/ui/posture";
import { deviceNoun, setPadDevice } from "../src/i18n/device";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { wakeSentence } from "../src/ui/wake-sentence";

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("a sheet's room starts under the status bar (R4-08)", () => {
  it("the top inset is the room's own padding, beside the keyboard's lift", () => {
    expect(sheetRoom(59, 0)).toMatchObject({ flex: 1, justifyContent: "flex-end", paddingTop: 59, paddingBottom: 0 });
    expect(sheetRoom(24, 336)).toMatchObject({ paddingTop: 24, paddingBottom: 336 });
  });
  it("both keyboard-carrying sheets are laid in it — the reply composer and the Sheet that avoids the keyboard", () => {
    for (const f of ["../src/ui/MessageActions.tsx", "../src/ui/Sheet.tsx"]) {
      expect(src(f).match(/style=\{sheetRoom\(insets\.top, keyboardLift\)\}/g), f).toHaveLength(1);
      expect(src(f), `${f} still lays a room with no top inset`).not.toMatch(/flex: 1, justifyContent: "flex-end", paddingBottom: keyboardLift/);
    }
  });
});

describe("an iPad window smaller than its screen pays the window controls as top inset (R3-02)", () => {
  const pad = { isPad: true, screen: { width: 820, height: 1180 } };
  it("Split View, Slide Over and a free window are windowed; full screen and every phone are not", () => {
    expect(windowedOnPad({ ...pad, window: { width: 405, height: 1180 } })).toBe(true);
    expect(windowedOnPad({ ...pad, window: { width: 375, height: 1116 } })).toBe(true);
    expect(windowedOnPad({ ...pad, window: { width: 701, height: 900 } })).toBe(true);
    expect(windowedOnPad({ ...pad, window: { width: 820, height: 1180 } })).toBe(false);
    expect(windowedOnPad({ isPad: false, screen: { width: 440, height: 956 }, window: { width: 300, height: 600 } })).toBe(false);
    expect(topInsetWithControls(24, { ...pad, window: { width: 405, height: 1180 } })).toBe(24 + IPAD_WINDOW_CONTROLS_PT);
    expect(topInsetWithControls(24, { ...pad, window: { width: 820, height: 1180 } })).toBe(24);
  });
  it("the root provider hands every reader the widened top, and the same provider when it is not widened", () => {
    rig.isPad = true; rig.window = { width: 405, height: 1180 };
    const split = WindowControlsInsets({ children: "app" }) as { type: unknown; props: { value: { top: number; bottom: number } } };
    expect(split.type).toBe("InsetsProvider");
    expect(split.props.value).toMatchObject({ top: 24 + IPAD_WINDOW_CONTROLS_PT, bottom: 20 });
    rig.window = { width: 820, height: 1180 };
    const full = WindowControlsInsets({ children: "app" }) as { type: unknown; props: { value: { top: number } } };
    expect(full.type, "a remount on entering Split View would close the open letter").toBe("InsetsProvider");
    expect(full.props.value.top).toBe(24);
  });
  it("where the system read the controls' edge, that edge is the top (Slide Over)", () => {
    rig.isPad = true; rig.window = { width: 375, height: 1100 }; rig.controlsTop = 68;
    const over = WindowControlsInsets({ children: "app" }) as { props: { value: { top: number } } };
    expect(over.props.value.top).toBe(68);
    rig.controlsTop = null;
  });
  it("is mounted at the root, inside the safe-area provider and around every screen", () => {
    const layout = src("../app/_layout.tsx");
    expect(layout.indexOf("<SafeAreaProvider>")).toBeLessThan(layout.indexOf("<WindowControlsInsets>"));
    expect(layout.indexOf("<WindowControlsInsets>")).toBeLessThan(layout.indexOf("<PostureProvider>"));
  });
});

describe("an iPad's sentences name an iPad (R3-03)", () => {
  it("the noun moves, its article with it, and iPhone is left alone", () => {
    expect(deviceNoun("Standalone on this phone", "en")).toBe("Standalone on this iPad");
    expect(deviceNoun("ohmail on a phone. A phone's keychain.", "en")).toBe("ohmail on an iPad. An iPad's keychain.");
    expect(deviceNoun("on iPhone and iPad the pairing stays in the phone's keychain", "en")).toBe("on iPhone and iPad the pairing stays in the iPad's keychain");
    expect(deviceNoun("two phones", "en")).toBe("two phones");
    expect(deviceNoun("Dieses Telefon und die Daten dieses Telefons", "de")).toBe("Dieses iPad und die Daten dieses iPads");
    expect(deviceNoun("Dieses Handy und die Daten dieses Handys", "de")).toBe("Dieses iPad und die Daten dieses iPads");
  });
  it("no sentence of either deck still says phone on an iPad", () => {
    for (const [locale, deck] of [["en", EN], ["de", DE]] as const) {
      for (const [k, v] of Object.entries(deck)) {
        if (typeof v !== "string") continue;
        const out = deviceNoun(v, locale);
        expect(out, `${locale}.${k}`).not.toMatch(locale === "en" ? /(?<![A-Za-z])[Pp]hone(?!s)\b/ : /\b(Telefon|Handy)s?\b/);
      }
    }
  });
  it("the live deck reads through it on an iPad and nowhere else", () => {
    setPadDevice(true);
    try {
      expect(Copy.doorPhone).toBe("Standalone on this iPad");
      expect(Copy.wakeNoPushIos).toContain("this iPad");
    } finally { setPadDevice(false); }
    expect(Copy.doorPhone).toBe(EN.doorPhone);
  });
});

describe("iOS names no push distributor (R3-04)", () => {
  it("the no-distributor state says what iOS does, and Android keeps its sentence", () => {
    const ios = wakeSentence({ k: "no_distributor" }, "ios");
    expect(ios).toBe(Copy.wakeNoPushIos);
    expect(ios).not.toMatch(/UnifiedPush|distributor/i);
    expect(wakeSentence({ k: "no_distributor" }, "android")).toBe(Copy.wakeNoDistributor);
    expect(DE.wakeNoPushIos).not.toMatch(/UnifiedPush|Verteiler/);
  });
  it("Settings renders it with the platform it runs on", () => {
    expect(src("../app/settings.tsx")).toContain("{wakeSentence(wake.state, Platform.OS)}");
  });
});
