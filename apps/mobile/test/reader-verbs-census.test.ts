/**
 * THE VERBS CENSUS — the product rule as arithmetic: "every function and button available,
 * visible and functional on every device × posture". For EVERY posture preset (the same table
 * the lane drives simulators with) × platform × message-fact variant, every verb the
 * message admits must be reachable — standing on the posture's surface or one press behind
 * ⋯ — and never in both places. A missing verb refuses BY NAME. The webapp's bar order is
 * derived from the webapp's own source, so the desktop bar and this bar cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  derivePosture,
  POSTURE_PRESETS,
  type PlatformName,
} from "../src/ui/posture/derive";
import { scaffoldPlan } from "../src/ui/scaffold/plan";
import { railColumnHeight } from "../src/ui/glass/fold";
import { UNDO_CLASS } from "@ohmail/client-engine";
import {
  admissibleVerbs,
  railReaderGroups,
  readerVerbMode,
  readerVerbPlacement,
  VERB_UNDO_ARM,
  type ReaderVerbFacts,
  type ReaderVerbId,
} from "../src/ui/reader-verbs";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The fact variants: the full message, and each absence rule exercised alone. */
const FACTS: Record<string, ReaderVerbFacts> = {
  everything: { canReplyAll: true, forwardOffered: true, junkOffered: true, screeningOffered: true },
  "no reply-all envelope": { canReplyAll: false, forwardOffered: true, junkOffered: true, screeningOffered: true },
  no_forward: { canReplyAll: true, forwardOffered: true, junkOffered: true, screeningOffered: true },
  "standalone door": { canReplyAll: true, forwardOffered: true, junkOffered: true, screeningOffered: true },
  "already in spam": { canReplyAll: true, forwardOffered: true, junkOffered: false, screeningOffered: true },
  "own mail": { canReplyAll: true, forwardOffered: true, junkOffered: true, screeningOffered: false },
};

function postureOf(name: string, platform: PlatformName) {
  const p = POSTURE_PRESETS[name]!;
  return derivePosture({
    platform,
    width: p.width,
    height: p.height,
    folds: p.folds ?? null,
    hasFold: p.hasFold,
    isPad: p.isPad,
    windowBounds: p.windowBounds ?? null,
  });
}

describe("every admissible verb is reachable on every posture preset", () => {
  for (const [name, preset] of Object.entries(POSTURE_PRESETS)) {
    const platforms: PlatformName[] = preset.platform ? [preset.platform] : ["ios", "android"];
    for (const platform of platforms) {
      it(`${name} (${platform})`, () => {
        const plan = scaffoldPlan(postureOf(name, platform), platform);
        const mode = readerVerbMode(plan);
        for (const [label, facts] of Object.entries(FACTS)) {
          const placement = readerVerbPlacement(mode, facts);
          const reachable = [...placement.standing, ...placement.behindMore];
          for (const verb of admissibleVerbs(facts)) {
            expect(
              reachable.includes(verb),
              `${name}/${platform} · ${label}: "${verb}" is neither standing nor behind ⋯ in mode "${mode}"`,
            ).toBe(true);
          }
          // in the row or behind More, never both
          const both = placement.standing.filter((v) => placement.behindMore.includes(v));
          expect(both, `${name}/${platform} · ${label}: verbs in both places`).toEqual([]);
          // and never a verb the message does not admit
          const admitted = new Set(admissibleVerbs(facts));
          expect(reachable.filter((v) => !admitted.has(v))).toEqual([]);
        }
      });
    }
  }
});

describe("the account's own mail is offered no Screening press (SENDER-SHEET-OFFERED-ON-OUR-OWN-MAIL)", () => {
  it("on every posture preset, neither standing nor behind ⋯, and the rest of the set stays", () => {
    for (const [name, preset] of Object.entries(POSTURE_PRESETS)) {
      for (const platform of (preset.platform ? [preset.platform] : ["ios", "android"]) as PlatformName[]) {
        const mode = readerVerbMode(scaffoldPlan(postureOf(name, platform), platform));
        const own = readerVerbPlacement(mode, FACTS["own mail"]!);
        const reachable = [...own.standing, ...own.behindMore];
        expect(reachable, `${name}/${platform}`).not.toContain("screening");
        expect(reachable, `${name}/${platform}: the control, somebody else's mail`).toContain("move");
        const theirs = readerVerbPlacement(mode, FACTS.everything!);
        expect([...theirs.standing, ...theirs.behindMore], `${name}/${platform}`).toContain("screening");
      }
    }
  });
});

describe("the mode per posture is the decided placement", () => {
  const modeOf = (name: string, platform: PlatformName) =>
    readerVerbMode(scaffoldPlan(postureOf(name, platform), platform));

  it("the unfolded-landscape Duo carries the verbs on the right-edge rail (flat and book)", () => {
    expect(modeOf("duo-unfolded", "ios")).toBe("rail");
    expect(modeOf("duo-book", "ios")).toBe("rail");
  });
  it("the desktop ActionBar rides the iPad both orientations, the inner-portrait Duo and the Android panes", () => {
    for (const [name, platform] of [
      ["ipad", "ios"],
      ["ipad-portrait", "ios"],
      ["duo-unfolded-portrait", "ios"],
      ["fold-inner", "android"],
      ["android-tablet", "android"],
      ["sd2", "android"],
    ] as const) {
      expect(modeOf(name, platform), name).toBe("bar");
    }
  });
  it("compact keeps the thumb bar — phones, the Flip, splits", () => {
    for (const [name, platform] of [
      ["phone", "ios"],
      ["phone", "android"],
      ["flip", "android"],
      ["duo-split-left", "ios"],
    ] as const) {
      expect(modeOf(name, platform), name).toBe("compact");
    }
  });
  it("the closed Duo's ONE rail carries the verbs over an open message — no bottom bar (the device pass, 2026-09-21)", () => {
    expect(modeOf("duo-closed", "ios")).toBe("rail");
    expect(modeOf("duo-closed-landscape", "ios")).toBe("rail");
  });
});

describe("the rail is the prototype's exact column", () => {
  it("back · [reply · reply all · forward] · [Done · Park · Junk] · ⋯, top-aligned", () => {
    const groups = railReaderGroups(FACTS.everything!);
    expect(groups).toEqual([
      ["back"],
      ["reply", "replyAll", "forward"],
      ["read", "aside", "junk"],
      ["more"],
    ]);
  });
  it("absence rules hold on the rail too, and Junk leaves with its move target", () => {
    expect(railReaderGroups(FACTS["no reply-all envelope"]!)[1]).toEqual(["reply", "forward"]);
    // Forward is always offered (owner, 2026-09-25): a no_forward message keeps it; the press asks.
    expect(railReaderGroups(FACTS.no_forward!)[1]).toEqual(["reply", "replyAll", "forward"]);
    expect(railReaderGroups(FACTS["already in spam"]!)[2]).toEqual(["read", "aside"]);
  });
  it("the full column FITS the Duo's inner height — the budget law never folds the chosen eight", () => {
    // 669dp inner landscape minus the rail's own top/bottom margins and generous insets.
    const column = railColumnHeight(railReaderGroups(FACTS.everything!).map((g) => g.map((id) => ({ id }))));
    expect(column).toBeLessThanOrEqual(560);
  });
});

describe("the bar's row order is the webapp's own BAR_VERB_ORDER", () => {
  it("derived from apps/webapp/app/shell/bar-density.ts, not a list kept here", () => {
    const density = read("../../webapp/app/shell/bar-density.ts");
    const block = density.match(/export const BAR_VERB_ORDER = \[([\s\S]*?)\] as const;/);
    expect(block, "bar-density.ts no longer declares BAR_VERB_ORDER").not.toBeNull();
    const NAME: Record<string, string> = { rall: "replyAll", fwd: "forward", screen: "screening" };
    const webOrder = [...block![1]!.matchAll(/verb: "(\w+)"/g)].map((m) => NAME[m[1]!] ?? m[1]!);
    const SEG: Record<string, string | null> = {};
    for (const m of block![1]!.matchAll(/verb: "(\w+)", seg: (null|"defer"|"file")/g)) {
      SEG[NAME[m[1]!] ?? m[1]!] = m[2] === "null" ? null : m[2]!.replaceAll('"', "");
    }
    /* FORWARD IS THE WEB BAR'S FLOOR (DESIGN-026 §2.1): out of the admission order, standing in
       the row between Reply all and the horizons (`MessagePane.tsx`). The web ROW is that order with
       Forward in its DOM seat, and a Forward back in the order would be counted twice here. */
    expect(webOrder, "Forward is admissible on the web again — it would fold").not.toContain("forward");
    const pane = read("../../webapp/app/shell/MessagePane.tsx");
    expect(pane, "the web bar's Forward is no longer a floor group").toContain('className="abar-g abar-fwd"');
    /* The phone's bar keeps the same floor: the reader hands `GlassActionBar` Forward as its floor. */
    const actions = read("../src/ui/MessageActions.tsx");
    expect(actions, "the phone bar's Forward is no longer its floor").toMatch(/<GlassActionBar[\s\S]*?floor=\{\["forward"\]\}/);
    const webRow = [...webOrder];
    webRow.splice(webRow.indexOf("replyAll") + 1, 0, "forward");
    const bar = readerVerbPlacement("bar", FACTS.everything!);
    // Reply leads, the read switch closes — between them, the webapp's row in its order.
    expect(bar.standing[0]).toBe("reply");
    expect(bar.standing[bar.standing.length - 1]).toBe("read");
    expect(bar.standing.slice(1, -1)).toEqual(webRow);
    // and Delete rides behind ⋯ — the desktop keeps no Junk row verb, Junk stays behind Move
    expect(bar.behindMore).toEqual(["delete"]);
    expect(webOrder.includes("junk")).toBe(false);
    // the segments are the webapp's too
    expect(SEG.later).toBe("defer");
    expect(SEG.move).toBe("file");
  });
  it("the compact bar stands Forward beside Reply, where both wide bars keep it in their floor", () => {
    const compact = readerVerbPlacement("compact", FACTS.everything!);
    expect(compact.standing.slice(0, 2)).toEqual(["reply", "forward"]);
    expect(compact.behindMore).not.toContain("forward");
  });
});

describe("every verb has an undo arm, and the mutation-backed arms agree with the engine", () => {
  it("no verb is unclassified — a verb that silently moves mail with no way back cannot ship", () => {
    // `Record<ReaderVerbId, VerbUndoArm>` already refuses a MISSING key at compile time; this
    // walk is the census's runtime half — an arm value outside the closed set refuses by name.
    const arms = new Set(["inverse", "window", "composer", "routing-bounded", "routing-none"]);
    for (const [verb, arm] of Object.entries(VERB_UNDO_ARM)) {
      expect(arms.has(arm), `"${verb}" carries an unknown undo arm "${arm}"`).toBe(true);
    }
    expect(Object.keys(VERB_UNDO_ARM).sort()).toEqual(
      (admissibleVerbs(FACTS.everything!) as string[]).sort(),
    );
  });

  it("the wire-backed arms are the engine's own classification (UNDO_CLASS), not a copy", () => {
    // Each verb names the MutationKind its press dispatches; the phone's arm must match how
    // the engine says that kind is taken back — a drift here is a pill promising an undo the
    // wire cannot honour, or withholding one it can.
    const DISPATCHES: Partial<Record<ReaderVerbId, keyof typeof UNDO_CLASS>> = {
      later: "triage_set",
      aside: "triage_set",
      resurface: "triage_set",
      read: "mark_seen",
      tag: "tag_assign",
      move: "move",
      delete: "message_delete",
    };
    for (const [verb, kind] of Object.entries(DISPATCHES) as [ReaderVerbId, keyof typeof UNDO_CLASS][]) {
      const arm = VERB_UNDO_ARM[verb];
      const engineSays = UNDO_CLASS[kind];
      if (arm === "inverse") expect(engineSays, `${verb} → ${kind}`).toBe("inverse");
      /**
       * MOVE IS A WINDOW NOW, and its two halves are why. The mail moves at the press and the
       * engine reverses it (`move` is "inverse"); the sender's RULES have no wire inverse
       * (`rule_update` is "none"), so they are HELD and Undo cancels them before they are sent.
       * The engine classifies the PLAN, not either half, and that is the entry the phone's arm
       * has to agree with — asserting `UNDO_CLASS[kind]` alone would read "inverse" for Move
       * and say nothing at all about the half that made this row open.
       */
      if (arm === "window" && verb === "move") {
        expect(UNDO_CLASS.move, `${verb} → ${kind}`).toBe("inverse");
        expect(UNDO_CLASS.rule_update).toBe("none");
        expect(UNDO_CLASS.routing_plan).toBe("window");
      } else if (arm === "window") {
        expect(engineSays, `${verb} → ${kind}`).toBe("window");
      }
    }
    // Screening rewrites rules on every press; the engine classifies that kind as none.
    expect(VERB_UNDO_ARM.screening).toBe("routing-none");
    expect(UNDO_CLASS.rule_create).toBe("none");
  });
});
