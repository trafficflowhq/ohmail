/**
 * THE CHROME'S STRUCTURE, MEASURED THE WAY THIS SUITE MEASURES COMPONENTS (no RN renderer in
 * this workspace — the mail-row idiom): the tab nav renders through the plan and the glass
 * primitives with every tab, route and badge the old dock carried; the wordmark is out of the
 * chrome and stays on welcome; a control's accessible name is the label the
 * copy deck supplies; the app is no longer locked to portrait, without which no landscape
 * posture can exist at all.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { palettes } from "../src/theme/palette";
import { ohmarchyPalettes } from "../src/theme/ohmarchy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const NAV = read("app/(tabs)/_layout.tsx");
/* The rail is the ROOT's (`src/ui/nav-rail.tsx`) so it stands on the pushed screens too; the tab
   bar renders the dock and yields the rail postures to it. */
const RAIL = read("src/ui/nav-rail.tsx");

describe("the tab navigation, migrated onto the glass grammar", () => {
  it("renders through the plan and both glass navs — the posture decides, the component obeys", () => {
    expect(NAV).toContain("scaffoldPlan(posture");
    expect(NAV).toContain("<GlassDock");
    expect(NAV).toContain('if (plan.nav === "rail") return null;');
    expect(NAV).toContain("usePosture()");
    expect(RAIL).toContain("scaffoldPlan(posture");
    expect(RAIL).toContain("<GlassRail");
    expect(RAIL).toContain("usePosture()");
    // placed by the one law, in the strip iOS reserves on the closed Duo
    expect(RAIL).toContain("railHome(plan, insets");
  });
  it("the root rail leads with Back off the tab roots and yields to the reader's claim", () => {
    expect(RAIL).toContain("isTabRoute(here)");
    expect(RAIL).toContain("router.back()");
    expect(RAIL).toContain("plan.railCarriesReaderVerbs && readerRail !== null) return null");
    // the connect flow draws no rail, and the root's one decision is what every screen clears
    expect(RAIL).toContain("if (!drawn) return null;");
    expect(read("app/_layout.tsx")).toContain('const navDrawn = gateFor(conn.state, conn.profiles.length).to === "mail";');
  });

  it("keeps every tab, in the dock's own order, with its icon", () => {
    const names = [...NAV.matchAll(/\{ name: "([a-z]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["index", "screener", "reads", "receipts", "more"]);
    for (const icon of ["ohbox", "door", "reads", "receipts", "more"]) {
      expect(NAV).toContain(`icon: "${icon}"`);
    }
  });

  it("opens More over the current compact mail screen and closes it before selecting a place", () => {
    expect(NAV).toMatch(/if \(id === "more" && onMore\) \{\s*onMore\(\);\s*return;/);
    expect(NAV).toContain("<MailPlacesDrawer");
    const drawer = read("src/ui/MailPlacesDrawer.tsx");
    expect(drawer).toContain("<GlassSidebar");
    expect(drawer).toContain("onNavigate={onClose}");
    expect(drawer).toContain('"hardwareBackPress"');
  });

  it("offers the calendar switch at the Ohbox title and in More", () => {
    expect(read("app/(tabs)/index.tsx")).toContain("<MailCalendarSwitch");
    expect(read("src/ui/MailPlacesDrawer.tsx")).toContain("<MailCalendarSwitch");
    expect(read("src/ui/MailCalendarSwitch.tsx")).toContain('sender.open({ to: "last" })');
  });

  it("keeps every badge on the engine's own counts — the fields, not a local derivation", () => {
    for (const field of ["w.ohbox.unread", "w.screener.waiting.length", "w.reads.newCount", "w.receipts.newCount"]) {
      expect(NAV).toContain(field);
      expect(RAIL).toContain(field);
    }
    expect(NAV).toContain("Copy.ariaLabelCount");
    expect(RAIL).toContain("Copy.ariaLabelCount");
  });

  it("search and New mail ride the nav on every posture, and each press opens its screen", () => {
    /* The rail moved to the ROOT in the same range that gave the phone a search SCREEN, so both
       sources are asked the same question: a pill answering "not yet" beside a dock that opens
       the screen is one control saying two things. */
    for (const src of [NAV, RAIL]) {
      expect(src).toContain("Copy.search");
      expect(src).toContain('router.push("/search")');
      expect(src).toContain('router.push("/compose")');
      expect(src).not.toContain("Copy.searchLater");
    }
    // the dock takes the two entries whole; the rail carries them as its own fixed actions
    expect(NAV).toContain("search={search}");
    expect(NAV).toContain("compose={compose}");
    expect(RAIL).toContain('id: "__search"');
    expect(RAIL).toContain('id: "__compose"');
  });
});

describe("no wordmark in the chrome", () => {
  it("the top strip, the tab nav and the root rail carry none", () => {
    expect(read("src/ui/chrome.tsx")).not.toContain("Wordmark");
    expect(NAV).not.toContain("Wordmark");
    expect(RAIL).not.toContain("Wordmark");
  });
  it("welcome keeps the mark — the rule moves it, it does not erase it", () => {
    expect(read("app/welcome.tsx")).toContain("Wordmark");
  });
});

describe("the app can take a posture at all", () => {
  const app = JSON.parse(read("app.json")) as {
    expo: { orientation: string; ios: { supportsTablet: boolean } };
  };
  it("orientation is not locked — the unfolded-landscape postures exist", () => {
    expect(app.expo.orientation).toBe("default");
  });
  it("the iPad runs the app — the design names it", () => {
    expect(app.expo.ios.supportsTablet).toBe(true);
  });
});

describe("the glass pair is the prototype's, in both faces", () => {
  it("paper: the v4/v5 --glass and --glass-brd, alphas kept", () => {
    expect(palettes.light.glass).toBe("rgba(254, 253, 251, 0.8)");
    expect(palettes.light.glassBrd).toBe("rgba(54, 44, 36, 0.1)");
    expect(palettes.dark.glass).toBe("rgba(40, 33, 29, 0.78)");
    expect(palettes.dark.glassBrd).toBe("rgba(243, 238, 230, 0.1)");
  });
  it("ohmarchy: its own float at the paper alphas — the material is the rule, the hue the face's", () => {
    expect(ohmarchyPalettes.light.glass).toBe("rgba(255,252,240,0.8)");
    expect(ohmarchyPalettes.dark.glass).toBe("rgba(26,27,38,0.78)");
    expect(ohmarchyPalettes.light.glassBrd).toBe("rgba(16,15,15,0.1)");
    expect(ohmarchyPalettes.dark.glassBrd).toBe("rgba(169,177,214,0.1)");
  });
});

describe("the accessible names are required, not optional", () => {
  it("GlassIconButton takes `label` and hands it to accessibilityLabel", () => {
    const src = read("src/ui/glass/GlassIconButton.tsx");
    expect(src).toContain("accessibilityLabel={label}");
    expect(src).toMatch(/label: string;/);
  });
  it("the dock's items are tabs with a selected state", () => {
    const src = read("src/ui/glass/GlassIconButton.tsx");
    expect(src).toContain('accessibilityState={{ selected: role === "tab" && on === true, disabled: disabled === true }}');
  });
});
