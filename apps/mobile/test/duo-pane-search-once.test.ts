/**
 * SEARCH STANDS ONCE PER POSTURE. Measured on the iPhone Duo on 2026-09-21: in unfolded
 * landscape "Search" matched twice — the rail's own pill and a second field at the list pane's
 * foot. Search rides the navigation on every posture (owner rule 5), so where the navigation IS
 * the rail the pill is that search and the foot stands down; where the nav is the bars (the iPad,
 * the Duo's inner portrait) the foot carries it, as the prototype draws. The pixels are the
 * device's to measure; the law is here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { POSTURE_PRESETS, derivePosture, type PostureInput } from "../src/ui/posture/derive";
import { paneFootSearch, scaffoldPlan } from "../src/ui/scaffold/plan";

const planAt = (name: string) => {
  const p = POSTURE_PRESETS[name];
  if (!p) throw new Error(`no preset ${name}`);
  const input: PostureInput = {
    platform: p.platform ?? "ios",
    width: p.width,
    height: p.height,
    folds: p.folds ?? null,
    hasFold: p.hasFold,
    isPad: p.isPad,
    windowBounds: p.windowBounds ?? null,
  };
  return { plan: scaffoldPlan(derivePosture(input), input.platform), platform: input.platform };
};

const source = (rel: string): string =>
  withoutComments(readFileSync(new URL(rel, import.meta.url).pathname, "utf8"));

describe("search stands once per posture", () => {
  it("the unfolded-landscape Duo's foot stands down — the rail's pill is the search", () => {
    const { plan, platform } = planAt("duo-unfolded");
    expect(plan.nav).toBe("rail");
    expect(paneFootSearch(plan, platform)).toBe(false);
  });

  it("the half-open book posture is the same rail, and the same one control", () => {
    const { plan, platform } = planAt("duo-book");
    expect(plan.nav).toBe("rail");
    expect(paneFootSearch(plan, platform)).toBe(false);
  });

  it("the inner portrait keeps the foot — its nav is the bars, which carry no pill", () => {
    const { plan, platform } = planAt("duo-unfolded-portrait");
    expect(plan.nav).toBe("bars");
    expect(paneFootSearch(plan, platform)).toBe(true);
  });

  it("the iPad keeps the foot", () => {
    const { plan, platform } = planAt("ipad");
    expect(plan.nav).toBe("bars");
    expect(paneFootSearch(plan, platform)).toBe(true);
  });

  it("Android's own rail carries search, so its two-pane foot renders nothing", () => {
    const { plan, platform } = planAt("fold-inner");
    expect(plan.nav).toBe("rail");
    expect(paneFootSearch(plan, platform)).toBe(false);
  });

  it("ListDetail renders the foot through the law, not through a platform test of its own", () => {
    const src = source("../src/ui/list-detail.tsx");
    expect(src).toContain('const foot = show === "pair" && paneFootSearch(plan, platformName);');
    /* The shape the defect had: a bare platform test, which is true on every iOS posture. */
    expect(src).not.toContain('{platformName === "ios" ? (');
  });
});
