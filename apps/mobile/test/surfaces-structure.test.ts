/**
 * THE SURFACES' STRUCTURE, measured the way this suite measures components (no RN renderer in
 * this workspace — the glass-nav idiom): every mail list mounts the list-detail pair; the
 * reader's three faces render through the one verb model and the real handlers; the nav
 * yields where the reader holds the rail and where the drawer owns the destinations; the
 * drawer, the pane search and the empty reading pane carry the deck's own words in both
 * catalogues.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paneFootSearch } from "../src/ui/scaffold/plan";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const LIST_SCREENS = [
  "app/(tabs)/index.tsx",
  "app/(tabs)/screener.tsx",
  "app/(tabs)/reads.tsx",
  "app/(tabs)/receipts.tsx",
  "app/history.tsx",
  "app/folder/[id].tsx",
] as const;

describe("every mail list mounts the list-detail pair", () => {
  for (const screen of LIST_SCREENS) {
    it(`${screen} — selection through useListDetail, detail beside the list`, () => {
      const src = read(`../${screen}`);
      expect(src).toContain("useListDetail(");
      expect(src).toContain("<ListDetail");
      expect(src).toContain("renderDetail={");
      // rows press the pair's one verb — never a bare push that bypasses the second pane
      expect(src.includes("router.push(`/message/"), `${screen} still pushes past the pane`).toBe(false);
      expect(src.includes("router.push(`/sender/"), `${screen} still pushes past the pane`).toBe(false);
    });
  }
  it("the message pane is the one reader; the screener pane is the one decision view", () => {
    expect(read("../app/(tabs)/index.tsx")).toContain("<MessageReader");
    expect(read("../app/(tabs)/screener.tsx")).toContain("<SenderDetail");
  });
});

describe("the reader's three faces are the one verb model", () => {
  const actions = read("../src/ui/MessageActions.tsx");
  it("the mode comes from the plan, the placement from reader-verbs", () => {
    expect(actions).toContain("readerVerbMode(plan, readerPaneWidth(");
    expect(actions).toContain("readerVerbPlacement(mode, facts)");
  });
  it("the bar face is the GlassActionBar with the read switch and Delete behind ⋯", () => {
    expect(actions).toContain("<GlassActionBar");
    expect(actions).toContain("readSwitch={{ label: readFace.label, icon: readFace.icon, onPress: readFace.press, a11yLabel:");
    expect(actions, "Forward stands on the bar's floor").toContain('floor={["forward"]}');
    expect(actions).toContain("extraMore={barExtraMore}");
  });
  it("the compact face wears the glass material and keeps its verbs", () => {
    expect(actions).toContain("<GlassPill");
    for (const verb of ["actionReply", "actionForward", "actionLater", "actionSetAside", "actionResurface", "actionMore"]) {
      expect(actions).toContain(`Copy.${verb}`);
    }
  });
  it("the rail face publishes the claim and releases it on unmount", () => {
    expect(actions).toContain("publishReaderRail(railReaderGroups(facts).map((g) => g.map(entry)))");
    expect(actions).toContain("return () => publishReaderRail(null);");
    // back closes the reader; ⋯ opens the rest — fixed, so the budget can never fold them
    expect(actions).toContain('{ id, icon: "back", label: Copy.back, fixed: true, onPress: onBack }');
    expect(actions).toContain('fixed: true, onPress: () => setOpen("more")');
  });
  it("the More sheet's rows are the placement's — one verb, one place", () => {
    for (const id of ["replyAll", "forward", "later", "resurface", "tag", "screening", "move", "read", "delete"]) {
      expect(actions).toContain(`moreHas("${id}")`);
    }
  });
});

describe("one rail, one nav — the yields", () => {
  const nav = read("../app/(tabs)/_layout.tsx");
  it("the tab nav yields the two-pane iOS postures to the drawer and the pane search", () => {
    expect(nav).toContain('if (plan.nav === "bars") return null;');
  });
  it("the tab nav yields the rail to the reader's claim", () => {
    expect(nav).toContain("if (plan.railCarriesReaderVerbs && readerRail !== null) return null;");
  });
  it("the pair renders the claimed rail at the same edge", () => {
    const ld = read("../src/ui/list-detail.tsx");
    expect(ld).toContain("plan.railCarriesReaderVerbs && readerRail !== null");
    expect(ld).toContain("<GlassRail groups={readerRail.groups}");
  });
});

describe("the drawer, the pane search and the empty pane", () => {
  const ld = read("../src/ui/list-detail.tsx");
  it("the drawer holds the account line, the destinations and everything More carries", () => {
    expect(ld).toContain("<MoreNav onNavigate={onNavigate} />");
    for (const dest of ["Copy.ohbox", "Copy.screener", "Copy.reads", "Copy.receipts"] as const) {
      expect(ld).toContain(dest);
    }
    expect(ld).toContain("w.account.name");
  });
  it("the sidebar toggle rides the list pane's TopBar through pane-chrome", () => {
    const chrome = read("../src/ui/chrome.tsx");
    expect(chrome).toContain("usePaneChrome()");
    expect(chrome).toContain("accessibilityLabel={Copy.sidebar}");
    expect(ld).toContain("openDrawer: () => setDrawerOpen(true)");
  });
  it("the iOS list pane keeps Mail's bottom search field, opening the search screen", () => {
    /* The field is still here and still opens the screen; WHICH postures draw it is now the
       plan's law, because the bare platform test was true on the rail postures too and rendered
       search a second time (`paneFootSearch`, measured on the Duo in unfolded landscape). */
    expect(ld).toContain("paneFootSearch(plan, platformName)");
    expect(paneFootSearch({ nav: "bars" }, "ios")).toBe(true);
    expect(ld).toContain("accessibilityLabel={Copy.search}");
    expect(ld).toContain('router.push("/search")');
  });
  it("the reading pane rests on the deck's empty state, both catalogues", () => {
    expect(ld).toContain("Copy.paneNothingOpen");
    const en = read("../src/copy.en.ts");
    const de = read("../src/copy.de.ts");
    for (const key of ["sidebar:", "paneNothingOpen:", "paneNothingOpenHint:"]) {
      expect(en).toContain(key);
      expect(de).toContain(key);
    }
  });
  it("a closed drawer leaves the screen and stops painting (v5) — the sidebar unmounts", () => {
    const sidebar = read("../src/ui/glass/GlassSidebar.tsx");
    expect(sidebar).toContain("if (!open) return null;");
  });
});
