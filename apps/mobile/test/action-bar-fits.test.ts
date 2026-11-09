/**
 * ═══ THE MESSAGE BAR IS ONE ROW, AND EVERY VERB IS STILL REACHABLE ═══════════════════════════
 *
 * Three laws have stood here. The bar was a horizontal scroller, and a horizontal ScrollView
 * CLIPS: on a 1080 × 2400 phone at 420 dpi the fourth verb was cut mid-glyph at rest. It was
 * then made to WRAP, which showed every verb — and put a second row of capsules over the message
 * on the iPhone 18 Pro (read at y 748 in the toast lane's frames). Neither is the law now: the
 * bar MEASURES, admits what fits on one line in row order, and folds the tail into ⋯.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace (`test/fourth-door.test.ts` records the
 * same absence against its own subject), so the capsules were measured where they are real: a
 * release APK on a lane AVD at 1080 × 2400 / 420 dpi, `uiautomator dump`, both languages, the
 * bounds converted at 420/160 = 2.625 px per dp. The dumps are the record. Only the TEXT half of
 * each capsule is pinned below — the chrome around it is `PILL`/`SOLID`, read from the module the
 * bar itself renders with, so a padding change moves the test too. The shipped bar reads its own
 * widths off a hidden copy at runtime; these are the pinned inputs the law is driven with here.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ─────────────────────────────────────────
 *
 *  · the verb row given `flexWrap: "wrap"` again                ⇒ "one row" RED.
 *  · `compactFit` admitting every verb whatever the room        ⇒ the 18 Pro cases RED.
 *  · the floor (unmeasured) made to stand every verb            ⇒ "measures before it shows" RED.
 *  · `BAR.moreBox` 36 → 0 (More's column unreserved)            ⇒ "More's column" RED.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BAR, PILL, SOLID, barLineWidth, compactFit, fitOneLine, pillWidth, solidWidth,
} from "../src/ui/action-bar-layout";
import { DECKS } from "../src/copy";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACTIONS = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");
const BASE = readFileSync(join(APP, "src/ui/base.tsx"), "utf8");

/**
 * The four verbs' rendered TEXT widths in dp, measured on the device (see the header). Reply
 * rides `Button`; the three horizons ride `BarToggle`. Keyed by the catalogue key so a label
 * that changes wording cannot keep an old measurement.
 */
const TEXT_DP: Record<"en" | "de", Record<string, number>> = {
  en: { actionReply: 34.19, actionForward: 50.29, actionLater: 32.05, actionSetAside: 28.62, actionResurface: 62.52 },
  de: { actionReply: 64.29, actionForward: 73.9, actionLater: 40.43, actionSetAside: 43.48, actionResurface: 115.48 },
};

/** The bar's row order: Reply (solid, never folds), then Later · Park · Resurface. */
const ROW = ["later", "aside", "resurface"] as const;
const KEY = { later: "actionLater", aside: "actionSetAside", resurface: "actionResurface" } as const;

/** The hidden copy's record, as the shipped bar hands it to `compactFit`. */
function widthsOf(locale: "en" | "de", fontScale = 1): Record<string, number> {
  const t = TEXT_DP[locale];
  return {
    __reply: solidWidth(t.actionReply * fontScale),
    later: pillWidth(t.actionLater * fontScale),
    aside: pillWidth(t.actionSetAside * fontScale),
    resurface: pillWidth(t.actionResurface * fontScale),
  };
}

/** What a set of standing verbs actually occupies: Reply, then a gap before each capsule. */
function lineUsed(standing: readonly string[], widths: Record<string, number>): number {
  return standing.reduce((sum, id) => sum + BAR.gap + widths[id], widths.__reply);
}

/** 360 dp is the smallest common phone; 411 is the 1080/420 dpi one the store frames were shot
 *  on; 402 is the iPhone 18 Pro this lane's row was measured on; 430 the biggest iPhone. */
const WIDTHS = [360, 390, 402, 411, 430] as const;
const PRO_18 = 402;
const LOCALES = ["en", "de"] as const;

describe("the label measurements are the labels the app ships", () => {
  it("names every verb the bar renders, in both catalogues, with a width", () => {
    for (const locale of LOCALES) {
      for (const key of Object.keys(TEXT_DP[locale])) {
        const label = (DECKS[locale] as unknown as Record<string, unknown>)[key];
        expect(typeof label, `${locale}.${key}`).toBe("string");
        expect((label as string).length, `${locale}.${key}`).toBeGreaterThan(0);
        // A capsule is never narrower than its own chrome — a zero here would be a lost pin.
        expect(TEXT_DP[locale][key], `${locale}.${key}`).toBeGreaterThan(10);
      }
      expect(ACTIONS).toContain(`Copy.${"actionResurface"}`);
    }
  });

  it("the German verbs are the long ones — which is why this bar is measured at all", () => {
    expect(TEXT_DP.de.actionResurface).toBeGreaterThan(TEXT_DP.en.actionResurface);
  });
});

describe("one row, at every width, in both languages", () => {
  for (const width of WIDTHS) {
    for (const locale of LOCALES) {
      it(`${width} dp · ${locale}: what stands fits the line, and the rest is behind ⋯`, () => {
        const widths = widthsOf(locale);
        const fit = compactFit({ verbs: ROW, widths, room: width });
        // Nothing is lost and nothing is in two places: the row and the sheet partition the set.
        expect([...fit.standing, ...fit.overflow].sort(), `${locale} at ${width} dp`)
          .toEqual([...ROW].sort());
        expect(fit.standing.filter((v) => fit.overflow.includes(v))).toEqual([]);
        // Row order is fold order: a later verb never stands while an earlier one is folded.
        expect(fit.standing, "the standing set is not a prefix of the row")
          .toEqual(ROW.slice(0, fit.standing.length));
        expect(lineUsed(fit.standing, widths), "the standing row is wider than its line")
          .toBeLessThanOrEqual(barLineWidth(width));
      });
    }
  }

  it("holds at a 1.3 font scale too — the bar folds, nothing is cut and nothing wraps", () => {
    for (const width of WIDTHS) {
      for (const locale of LOCALES) {
        const widths = widthsOf(locale, 1.3);
        const fit = compactFit({ verbs: ROW, widths, room: width });
        expect([...fit.standing, ...fit.overflow].sort(), `${locale} ${width}`).toEqual([...ROW].sort());
        expect(lineUsed(fit.standing, widths), `${locale} ${width}`).toBeLessThanOrEqual(barLineWidth(width));
      }
    }
  });

  it("measures before it shows: an unread room or unread widths stand nothing", () => {
    const widths = widthsOf("en");
    expect(compactFit({ verbs: ROW, widths, room: null }))
      .toEqual({ standing: [], overflow: [...ROW], leadIcon: false });
    expect(compactFit({ verbs: ROW, widths: null, room: PRO_18 }))
      .toEqual({ standing: [], overflow: [...ROW], leadIcon: false });
  });
});

/**
 * FORWARD STANDS BESIDE REPLY WHILE IT COSTS NO HORIZON. The five-verb row — Reply, Forward, Later,
 * Park, Resurface — at the cover's widths and the phone ones. Forward rides `Button` plain (the
 * `SOLID` box, measured on the rig at 420 dpi like the rest): its word while Later still stands
 * after it, else its 44-dp icon while that leaves Later standing; where even the icon leaves no horizon
 * standing, Forward goes behind ⋯ and the first horizon stands. The German bar stood Antworten ·
 * Weiterleiten · ⋯ at 411 dp, no triage verb at all.
 */
describe("five verbs, Forward beside Reply while it costs no horizon", () => {
  const FIVE = ["forward", ...ROW] as const;
  const withForward = (locale: "en" | "de", fontScale = 1): Record<string, number> => ({
    ...widthsOf(locale, fontScale), forward: solidWidth(TEXT_DP[locale].actionForward * fontScale), "forward.icon": 44,
  });
  const used = (fit: ReturnType<typeof compactFit>, w: Record<string, number>) =>
    fit.standing.reduce((sum, id) => sum + BAR.gap + (id === "forward" && fit.leadIcon ? w["forward.icon"]! : w[id]!), w.__reply!);

  for (const width of [303, 320, 353, 360, 390, 404, 411, 430]) {
    for (const locale of LOCALES) {
      it(`${width} dp · ${locale}: every verb placed once, nothing over the line, a horizon before a lone Forward`, () => {
        const w = withForward(locale);
        const fit = compactFit({ verbs: FIVE, widths: w, room: width, lead: "forward" });
        expect([...fit.standing, ...fit.overflow].sort()).toEqual([...FIVE].sort());
        expect(fit.standing.filter((v) => fit.overflow.includes(v))).toEqual([]);
        const horizons = fit.standing.filter((v) => v !== "forward");
        expect(horizons).toEqual(ROW.slice(0, horizons.length));
        expect(horizons.length, `${locale} at ${width} dp: no triage verb stands`).toBeGreaterThan(0);
        if (fit.standing.includes("forward")) expect(fit.standing[0]).toBe("forward");
        expect(used(fit, w), `${locale} at ${width} dp`).toBeLessThanOrEqual(barLineWidth(width));
      });
    }
  }

  const at = (locale: "en" | "de", room: number, w: Record<string, number> = withForward(locale)) =>
    compactFit({ verbs: FIVE, widths: w, room, lead: "forward" });

  it("wherever Reply · Later fits the line, a horizon stands, at every text size", () => {
    for (const locale of LOCALES) {
      for (const scale of [1, 1.1, 1.15, 1.2, 1.3, 1.5]) {
        const w = withForward(locale, scale);
        for (let room = 280; room <= 480; room++) {
          if (w.__reply! + BAR.gap + w.later! > barLineWidth(room)) continue;
          const fit = at(locale, room, w);
          expect(fit.standing.filter((v) => v !== "forward").length, `${locale} ×${scale} at ${room} dp`).toBeGreaterThan(0);
        }
      }
    }
  });

  /* The German phones of the layout census (411, 372, 360 dp; the bar's room is the window). */
  it("German phones stand Später beside Antworten and Forward's icon", () => {
    for (const room of [411, 372, 360]) {
      expect(at("de", room), `de ${room}`).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: true });
    }
  });

  /* The review's frame reading (whole capsules): Antworten 120, Weiterleiten 135, Später 88,
     Parken 84, Wieder auftauchen 150 — the same faces as the rig's text widths. */
  it("the frame-read German capsules give the same faces", () => {
    const frame = { __reply: 120, forward: 135, "forward.icon": 44, later: 88, aside: 84, resurface: 150 };
    for (const room of [411, 372, 360]) {
      expect(at("de", room, frame), `de ${room}`).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: true });
    }
  });

  it("English phones keep Forward's word beside Later; the icon only where the word would push Later out", () => {
    for (const room of [430, 411, 402, 393, 390, 375]) {
      expect(at("en", room), `en ${room}`).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: false });
    }
    expect(at("en", 360)).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: false });
    expect(at("en", 303)).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: true });
  });

  it("where even the icon stands no horizon, Forward goes behind ⋯ and the first horizon stands", () => {
    expect(at("de", 353)).toEqual({ standing: ["forward", "later"], overflow: ["aside", "resurface"], leadIcon: true });
    expect(at("de", 320)).toEqual({ standing: ["later"], overflow: ["forward", "aside", "resurface"], leadIcon: false });
    expect(at("de", 303)).toEqual({ standing: ["later"], overflow: ["forward", "aside", "resurface"], leadIcon: false });
    expect(at("de", 330)).toEqual({ standing: ["later"], overflow: ["forward", "aside", "resurface"], leadIcon: false });
    expect(at("en", 300, withForward("en", 1.3))).toEqual({ standing: ["later"], overflow: ["forward", "aside", "resurface"], leadIcon: false });
  });

  it("a line too narrow for any horizon keeps Forward's icon rather than an empty row", () => {
    expect(at("de", 250)).toEqual({ standing: ["forward"], overflow: [...ROW], leadIcon: true });
  });
});

describe("before the bar has measured, Forward is in the sheet", () => {
  const FIVE = ["forward", ...ROW] as const;
  it("an unread room, a zero room or unread widths put every verb — Forward too — behind ⋯", () => {
    const w = { ...widthsOf("en"), forward: solidWidth(TEXT_DP.en.actionForward), "forward.icon": 44 };
    for (const [widths, room] of [[w, null], [w, 0], [null, 404]] as const) {
      const fit = compactFit({ verbs: FIVE, widths, room, lead: "forward" });
      expect(fit.standing, `room ${room}`).toEqual([]);
      expect(fit.overflow, `room ${room}: Forward is on neither the row nor the sheet`).toContain("forward");
    }
  });
});

describe("the defect, as arithmetic", () => {
  it("the whole set does not fit one line on the iPhone 18 Pro — so something must fold", () => {
    for (const locale of LOCALES) {
      const widths = widthsOf(locale);
      expect(lineUsed(ROW, widths), `${locale}: the whole row would have fitted after all`)
        .toBeGreaterThan(barLineWidth(PRO_18));
      const fit = compactFit({ verbs: ROW, widths, room: PRO_18 });
      expect(fit.overflow.length, `${locale}: nothing folded, so the bar is two rows again`)
        .toBeGreaterThan(0);
    }
  });

  it("the German bar folds more than the English one at the same width", () => {
    const de = compactFit({ verbs: ROW, widths: widthsOf("de"), room: PRO_18 });
    const en = compactFit({ verbs: ROW, widths: widthsOf("en"), room: PRO_18 });
    expect(de.overflow.length).toBeGreaterThanOrEqual(en.overflow.length);
    expect(de.standing.length).toBeLessThanOrEqual(en.standing.length);
  });

  it("a verb wider than the whole line folds rather than standing clipped", () => {
    const fit = fitOneLine([500], barLineWidth(PRO_18), 0);
    expect(fit.standing).toEqual([]);
    expect(fit.overflow).toEqual([0]);
  });
});

/** Source with every comment removed. A census that reads a comment measures the comment. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[^]*?\*\/\}/g, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the bar renders the law it is measured by", () => {
  /**
   * The bar's own block, comments stripped: the verb container down to the More sheet. Returned
   * rather than computed once, so a tree whose bar has moved reddens the CASES that read it
   * instead of failing collection — a file that collects nothing is a gate saying nothing.
   */
  function barBlock(): string {
    const whole = code(ACTIONS);
    const open = whole.indexOf("setCompactRoom((r) => nextRoom(");
    const close = whole.indexOf('<Sheet open={open === "more"}', open === -1 ? 0 : open);
    if (open === -1 || close <= open) return "";
    return whole.slice(open, close);
  }

  it("the bar's verb block is where this test reads it", () => {
    expect(barBlock().length, "no compact bar ahead of the More sheet").toBeGreaterThan(0);
    expect(barBlock(), "the block read is not the compact bar's").toContain("BarToggle");
  });

  it("the verbs ride one row — no wrap, and no horizontal scroller", () => {
    expect(barBlock(), "a wrapping row is the second-row defect").not.toMatch(/flexWrap/);
    expect(code(ACTIONS), "a horizontal ScrollView clips — that was the defect before").not.toMatch(
      /<ScrollView[^>]*\bhorizontal\b/,
    );
    expect(barBlock()).not.toContain("ScrollView");
  });

  it("the widths come from a hidden copy that is out of the touch path and the a11y tree", () => {
    const block = barBlock();
    expect(block).toContain('recordWidth("__reply")');
    expect(block).toContain("accessibilityElementsHidden");
    expect(block).toContain('importantForAccessibility="no-hide-descendants"');
    expect(block).toContain('pointerEvents="none"');
    expect(block).toMatch(/opacity: 0/);
  });

  it("the room is the wrapper's measured width, and a zero reading is not a room", () => {
    const whole = code(ACTIONS);
    /* The width is bound out of the wrapper's own layout event FIRST — the pooled event is
       null by the time a state updater runs — and it reaches the state through `nextRoom`,
       which is where a transient 0 is refused. The needle follows the binding, not the
       expression that used to read the event inside the updater. */
    expect(whole, "the width is not bound out of the wrapper's own layout event").toMatch(
      /const \{[^}]*\bwidth\b[^}]*\} = e\.nativeEvent\.layout;/,
    );
    expect(whole, "the measured width does not reach the room through nextRoom").toContain(
      "setCompactRoom((r) => nextRoom(r, width))",
    );
    expect(whole).toContain("room: compactRoom");
  });

  it("only the admitted verbs are rendered, and More stands outside the row", () => {
    const block = barBlock();
    expect(block).toContain("barFit.standing.includes(v.id)");
    const rowClose = block.indexOf("</View>", block.indexOf("barFit.standing.includes(v.id)"));
    const more = block.indexOf("Copy.actionMore");
    expect(rowClose, "the verb row is never closed").toBeGreaterThan(-1);
    expect(more, "More is not after the row").toBeGreaterThan(rowClose);
  });

  it("a folded verb is in the sheet — every capsule the row can fold has a row there", () => {
    const whole = code(ACTIONS);
    expect(whole).toContain("placement.behindMore.includes(id) || barFit.overflow.includes(id)");
    for (const id of ROW) {
      expect(whole, `${id} folds out of the row into nothing`).toContain(`moreHas("${id}")`);
      expect(whole, `${id} has no sheet row to fold into`).toContain(`Copy.${KEY[id]}`);
    }
  });

  it("the bar reserves More's column and pays both paddings, so a capsule cannot run under it", () => {
    expect(BAR.moreBox).toBeGreaterThan(0);
    expect(barLineWidth(411)).toBe(411 - 2 * BAR.outerPadH - 2 * BAR.padH - BAR.gap - BAR.moreBox);
    // The square is the icon plus its padding on both sides, and the component derives the
    // padding from `BAR.moreBox` — so the two cannot disagree.
    expect(barBlock()).toContain("padding: (BAR.moreBox - 16) / 2");
    expect(barBlock()).toContain('<Icon name="more" size={16}');
    // And the outer padding the line pays is the padding the wrapper renders.
    expect(code(ACTIONS)).toContain("paddingHorizontal: BAR.outerPadH");
  });
});

describe("the constants the test measures with are the constants the bar renders with", () => {
  it("the bar's box comes from BAR, not from literals", () => {
    expect(ACTIONS).toContain("paddingHorizontal: BAR.padH");
    expect(ACTIONS).toContain("gap: BAR.gap");
  });

  it("the capsule's box comes from PILL", () => {
    expect(ACTIONS).toContain("gap: PILL.iconGap");
    expect(ACTIONS).toContain("minHeight: PILL.minH");
    expect(ACTIONS).toContain("paddingHorizontal: PILL.padH");
    expect(ACTIONS).toContain("size={PILL.icon}");
  });

  it("a capsule may wrap its own label but may never be cut", () => {
    expect(ACTIONS).toContain('maxWidth: "100%"');
    expect(ACTIONS).toMatch(/style=\{\{ flexShrink: 1 \}\}/);
    expect(ACTIONS, "a verb is never ellipsized").not.toMatch(/numberOfLines=\{1\}[^]{0,200}Copy\.action(Reply|Later|SetAside|Resurface)\}/);
  });

  /**
   * Reply rides the shared `Button`, whose box lives in `base.tsx`. `SOLID` mirrors it, so this
   * case is the pin: move the primitive's padding and the mirror is caught the same day.
   */
  it("SOLID still mirrors base.tsx's Button", () => {
    const block = BASE.slice(BASE.indexOf("export function Button"), BASE.indexOf("export function Tap"));
    expect(block).toContain(`paddingHorizontal: ${SOLID.padH}`);
    expect(block).toContain(`gap: ${SOLID.iconGap}`);
    expect(block).toContain(`size={${SOLID.icon}}`);
  });
});
