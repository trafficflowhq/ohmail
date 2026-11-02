/**
 * ═══ THE PINNED ACTIONBAR ADMITS VERBS BY THE PANE'S WIDTH — THE DESKTOP'S OWN LAW ══════════
 *
 * The iPad expanded reader shipped with only Reply · Mark unread · ⋯ standing at a ~584pt
 * reading pane, where the desktop stands four more verbs. The cause was not the admission
 * arithmetic: the bar read its ROOM off its own root View, and the mount centered that root,
 * so the root was content-sized — the row's own floor width written back as its room, the
 * feedback loop `bar-density.ts` names on the webapp, and nothing past the floor could ever
 * stand. The fix stretches the root to the mount (the strip spanning the reading pane) and
 * follows every layout reading (`nextRoom`), so a posture flip or rotation re-admits.
 *
 * EXPECTED LISTS ARE DERIVED, NEVER HAND-TYPED: the webapp's `bar-density.ts` is imported at
 * runtime and ITS `admitVerbs` answers what stands at each pane width; the mobile admission
 * must equal that answer verb for verb. The pane widths come from the real geometry pipeline
 * (`derivePosture` → `scaffoldPlan` → `paneSplit`, the functions `list-detail.tsx` renders
 * with). Capsule widths are a fixture: the en labels at the device-measured ~6.95 dp/char
 * (`action-bar-fits.test.ts`'s uiautomator dumps — "Resurface" 62.52dp / 9 chars) plus the
 * chrome `GlassActionBar` renders (capsule padH 12×2; icon 13 + gap 5; solid padH 14×2;
 * More minWidth 40), with icon presence read off `MessageActions.tsx`'s own `barSpec`.
 *
 * FORWARD IS THE FLOOR ON BOTH BARS (DESIGN-026 §2.1): it stands after Reply all at every width,
 * its word or, on a tight floor, its icon. The phone's floor is read off the reader's
 * `floor={…}` prop and fed to `barFloorFaces` + `barAdmitted` as `GlassActionBar` feeds them.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven; kit/mutate/mutation-control.sh) ────────
 *  · `alignSelf: "stretch"` off the bar's root            ⇒ the wiring pin RED.
 *  · `nextRoom` first-write-wins (`prev ?? …`)            ⇒ "a posture flip re-admits" RED.
 *  · `nextRoom` follows a zero reading (`return width`)   ⇒ "a transient 0" RED.
 *  · `barAdmitted` drops the segment-track charge         ⇒ the boundary arm RED.
 *  · the reader passes no `floor`                          ⇒ the floor read RED.
 *  · `barAdmitted` keeps the floor among its boxes         ⇒ the boundary arm RED.
 *  · the model walks the pre-floor law (no `floor`)        ⇒ the Duo 345 dp pane RED.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";
import {
  BAR_GAP,
  BAR_PILL_CHROME,
  SEG_TRACK_PAD,
  barAdmitted,
  barFloorFaces,
  nextRoom,
  type BarVerbLite,
} from "../src/ui/glass/fold";
import { derivePosture, POSTURE_PRESETS, type PlatformName, type PostureInput } from "../src/ui/posture/derive";
import { paneSplit, scaffoldPlan } from "../src/ui/scaffold/plan";
import { readerVerbMode, readerVerbPlacement, type ReaderVerbFacts } from "../src/ui/reader-verbs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(APP, rel), "utf8");

/* ── the desktop law, imported at runtime (a literal import would drag DOM types into this
      app's typecheck — the census reads the same file as text for the same reason) ─────────── */
interface WebMeasuredVerb {
  name: string;
  width: number;
  seg: string | null;
}
let webAdmit: (availPx: number, basePx: number, verbs: WebMeasuredVerb[], gapPx: number) => string[];
let webOrder: { id: string; seg: string | null }[];
/** bar-density's verb tokens → this app's `ReaderVerbId`s — the census's own map. */
const NAME: Record<string, string> = { rall: "replyAll", fwd: "forward", screen: "screening" };
beforeAll(async () => {
  const url = pathToFileURL(join(APP, "..", "webapp", "app", "shell", "bar-density.ts")).href;
  const density = (await import(url)) as {
    admitVerbs: typeof webAdmit;
    BAR_VERB_ORDER: readonly { verb: string; seg: string | null }[];
  };
  webAdmit = density.admitVerbs;
  webOrder = density.BAR_VERB_ORDER.map((v) => ({ id: NAME[v.verb] ?? v.verb, seg: v.seg }));
});

/* ── the width fixture: en labels × the measured metric + the component's chrome ──────────── */
const CHAR_DP = 6.95;
const en = DECKS.en;
/** Which bar verbs render an icon, read off `barSpec`'s own case lines — never a copy here. */
const SPEC = [...read("src/ui/MessageActions.tsx").matchAll(
  /case "(\w+)": return \{ id,( icon: "\w+",)? label: Copy\.(\w+)/g,
)].reduce<Record<string, { iconed: boolean; key: string }>>((m, hit) => {
  m[hit[1]!] = { iconed: hit[2] !== undefined, key: hit[3]! };
  return m;
}, {});
const capsuleW = (label: string, iconed: boolean) => label.length * CHAR_DP + 24 + (iconed ? 18 : 0);
const label = (key: string) => (en as unknown as Record<string, string>)[key]!;

const FACTS: ReaderVerbFacts = { canReplyAll: true, forwardOffered: true, junkOffered: true, screeningOffered: true };
/** The bar's verb row — the placement's standing set minus the two fixed slots. */
const barIds = readerVerbPlacement("bar", FACTS).standing.filter((v) => v !== "reply" && v !== "read");

function widthsTable(): Record<string, number> {
  const t: Record<string, number> = {
    __reply: label("actionReply").length * CHAR_DP + 28,
    __read: capsuleW(label("actionMarkUnread"), false),
    __more: 40,
  };
  for (const id of barIds) {
    const spec = SPEC[id];
    expect(spec, `barSpec has no case for "${id}"`).toBeDefined();
    t[id] = capsuleW(label(spec!.key), spec!.iconed);
  }
  return t;
}

/** The verbs with their segments, in the desktop's row order — derived above. Forward is the web
 *  bar's FLOOR (DESIGN-026 §2.1): out of the admission order, standing after Reply all
 *  (`MessagePane.tsx`), so the web ROW is the order with Forward in that seat — the reader-verbs
 *  census's own derivation. */
function liteVerbs(): BarVerbLite[] {
  expect(webOrder.map((v) => v.id), "Forward is admissible on the web again — it would fold").not.toContain("forward");
  expect(read("../webapp/app/shell/MessagePane.tsx"), "the web bar's Forward is no longer a floor group").toContain('className="abar-g abar-fwd"');
  const row = [...webOrder];
  row.splice(row.findIndex((v) => v.id === "replyAll") + 1, 0, { id: "forward", seg: null });
  expect(barIds, "the bar's standing set drifted from the webapp's row").toEqual(row.map((v) => v.id));
  return row.map((v) => ({ id: v.id, seg: v.seg }));
}

/** The same boxes both laws are fed: the track's padding charged to a run's second member. */
function chargedBoxes(verbs: BarVerbLite[], W: Record<string, number>): WebMeasuredVerb[] {
  return verbs.map((v, i) => {
    const seg = v.seg ?? null;
    const second =
      seg !== null && i > 0 && (verbs[i - 1]!.seg ?? null) === seg &&
      (i === 1 || (verbs[i - 2]!.seg ?? null) !== seg);
    return { name: v.id, width: W[v.id]! + (second ? SEG_TRACK_PAD : 0), seg };
  });
}

/** What the DESKTOP answers at this room — bar-density's walk over the same inputs. Forward is in
 *  its floor: its width is in the base, it never folds, and it stands after Reply all. */
function desktopList(room: number, verbs: BarVerbLite[], W: Record<string, number>): string[] {
  const base = W["__reply"]! + BAR_GAP + W["forward"]! + BAR_GAP + W["__read"]! + BAR_GAP + W["__more"]!;
  const order = verbs.filter((v) => v.id !== "forward");
  const admitted = webAdmit(room - BAR_PILL_CHROME, base, chargedBoxes(order, W), BAR_GAP);
  const seat = admitted.indexOf("replyAll") + 1;
  return [...admitted.slice(0, seat), "forward", ...admitted.slice(seat)];
}

/** The phone bar's floor, read off the reader's `<GlassActionBar floor={…}>` — never a copy here. */
function phoneFloor(): string[] {
  const hit = read("src/ui/MessageActions.tsx").match(/<GlassActionBar[\s\S]*?floor=\{\[([^\]]*)\]\}/);
  expect(hit, "the reader passes the bar no floor").not.toBeNull();
  return [...hit![1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
}

/** The phone bar's standing list at this room: `GlassActionBar`'s own walk — the floor's faces, the
 *  admission with the floor as fixed cost, the floor kept in its row place. */
function mobileList(room: number | null, verbs: BarVerbLite[], W: Record<string, number>): string[] {
  const floor = phoneFloor();
  const faces = barFloorFaces({ widths: W, room, reply: true, readSwitch: true, floor });
  const n = barAdmitted({ verbs, widths: faces.widths, reply: true, readSwitch: true, room, floor });
  const admitted = new Set(verbs.filter((v) => !floor.includes(v.id)).slice(0, n).map((v) => v.id));
  return verbs.filter((v) => floor.includes(v.id) || admitted.has(v.id)).map((v) => v.id);
}

/* ── the postures: pane width from the real geometry pipeline ─────────────────────────────── */
function paneWidth(input: PostureInput): number {
  const p = derivePosture(input);
  const plan = scaffoldPlan(p, input.platform);
  expect(readerVerbMode(plan), "this posture no longer takes the bar").toBe("bar");
  const split = paneSplit(p, plan, input.width, input.height);
  expect(split).not.toBeNull();
  // list-detail.tsx: padding = gutter each side (nav "bars" has no rail), list pane = first,
  // the seam = gap, the reading pane takes the rest — the strip the bar's mount spans.
  return input.width - 2 * plan.gutter - split!.first - split!.gap;
}
const preset = (name: string, platform: PlatformName): PostureInput => {
  const p = POSTURE_PRESETS[name]!;
  return {
    platform,
    width: p.width,
    height: p.height,
    folds: p.folds ?? null,
    hasFold: p.hasFold,
    isPad: p.isPad,
    windowBounds: p.windowBounds ?? null,
  };
};
const IPAD13: Record<"portrait" | "landscape", PostureInput> = {
  portrait: { platform: "ios", width: 1032, height: 1376, folds: null, hasFold: false, isPad: true },
  landscape: { platform: "ios", width: 1376, height: 1032, folds: null, hasFold: false, isPad: true },
};

describe("the bar's standing verbs equal the desktop's at the pane's width", () => {
  const cases: [string, () => PostureInput][] = [
    ["iPad Pro 13 expanded, portrait (1032×1376)", () => IPAD13.portrait],
    ["iPad Pro 13 expanded, landscape (1376×1032)", () => IPAD13.landscape],
    ["iPad medium width, portrait (preset ipad-portrait)", () => preset("ipad-portrait", "ios")],
    ["iPad landscape (preset ipad)", () => preset("ipad", "ios")],
    ["Duo unfolded portrait (preset duo-unfolded-portrait)", () => preset("duo-unfolded-portrait", "ios")],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      const verbs = liteVerbs();
      const W = widthsTable();
      const room = paneWidth(input());
      expect(mobileList(room, verbs, W), `pane ${room}dp`).toEqual(desktopList(room, verbs, W));
    });
  }

  it("the phone's floor is the web's: Forward alone, and the pane that holds one verb gives it Forward", () => {
    expect(phoneFloor()).toEqual(["forward"]);
    const verbs = liteVerbs();
    const W = widthsTable();
    const room = paneWidth(preset("duo-unfolded-portrait", "ios"));
    expect(desktopList(room, verbs, W), `pane ${room}dp`).toEqual(["forward"]);
    expect(mobileList(room, verbs, W), `pane ${room}dp`).toEqual(["forward"]);
  });

  it("the iPad 13 landscape pane stands the WHOLE desktop set — the shipped defect's direction", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    const room = paneWidth(IPAD13.landscape);
    expect(desktopList(room, verbs, W)).toEqual(verbs.map((v) => v.id));
    expect(mobileList(room, verbs, W)).toEqual(verbs.map((v) => v.id));
  });

  it("a segment run's second member pays the track's padding — the boundary folds where the desktop folds", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    const boxes = chargedBoxes(verbs, W);
    // The room that seats exactly rall · fwd · later · aside (aside carries the track charge),
    // then two dp less: both laws must fold aside together — an uncharged mobile box admits it.
    const base = W["__reply"]! + BAR_GAP + W["__read"]! + BAR_GAP + W["__more"]! + BAR_PILL_CHROME;
    const cost4 = base + boxes.slice(0, 4).reduce(
      (a, b, i) => a + b.width + (b.seg !== null && boxes[i - 1]?.seg === b.seg ? 0 : BAR_GAP), 0);
    expect(mobileList(cost4, verbs, W)).toEqual(desktopList(cost4, verbs, W));
    expect(mobileList(cost4, verbs, W)).toHaveLength(4);
    expect(mobileList(cost4 - 2, verbs, W)).toEqual(desktopList(cost4 - 2, verbs, W));
    expect(mobileList(cost4 - 2, verbs, W)).toHaveLength(3);
  });
});

describe("the room follows layout — the feedback loop cannot come back", () => {
  it("before any layout the floor stands; a first 0-width reading is not a room", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    expect(mobileList(null, verbs, W)).toEqual(["forward"]);
    expect(nextRoom(null, 0)).toBeNull();
  });

  it("the 0-width first layout admits the full set once the real layout lands", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    const room = nextRoom(nextRoom(null, 0), paneWidth(IPAD13.landscape));
    expect(mobileList(room, verbs, W)).toEqual(verbs.map((v) => v.id));
  });

  it("a posture flip re-admits: portrait's pane, then landscape's, grows the row", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    const portrait = nextRoom(null, paneWidth(IPAD13.portrait));
    const flipped = nextRoom(portrait, paneWidth(IPAD13.landscape));
    expect(flipped).toBe(paneWidth(IPAD13.landscape));
    expect(mobileList(flipped, verbs, W).length).toBeGreaterThan(mobileList(portrait, verbs, W).length);
  });

  it("a transient 0 mid-rotation keeps the standing room", () => {
    const room = nextRoom(paneWidth(IPAD13.landscape), 0);
    expect(room).toBe(paneWidth(IPAD13.landscape));
  });

  it("the shipped defect's arithmetic: a room read off the row's own floor admits nothing past it", () => {
    const verbs = liteVerbs();
    const W = widthsTable();
    const floorW = W["__reply"]! + BAR_GAP + W["__read"]! + BAR_GAP + W["__more"]! + BAR_PILL_CHROME;
    expect(mobileList(floorW, verbs, W)).toEqual(["forward"]);
  });
});

describe("the component wires that model (no RN renderer in this workspace — the glass idiom)", () => {
  const bar = read("src/ui/glass/GlassActionBar.tsx");
  it("the root STRETCHES to the mount and stays out of the touch path", () => {
    expect(bar).toContain('style={{ alignSelf: "stretch", alignItems: "center" }}');
    expect(bar).toContain('pointerEvents="box-none"');
  });
  it("every layout reading updates the room through nextRoom, from a width read IN the handler", () => {
    // The literal this pinned until 2026-09-22 read the pooled event inside the updater, which
    // runs after RN has nulled `nativeEvent` — the pin held the crash in place. Two assertions
    // now: the room still comes from nextRoom, and the width is a local the handler captured.
    expect(bar).toContain("const w = e.nativeEvent.layout.width;");
    expect(bar).toContain("setRoom((r) => nextRoom(r, w));");
    expect(bar).not.toContain("nextRoom(r, e.nativeEvent");
  });
  it("the admission is barAdmitted — one law, shared with this suite", () => {
    expect(bar).toContain("barAdmitted({");
  });
  it("the floor reaches both laws and keeps its row place, as this suite's model walks it", () => {
    expect(bar).toContain("const faces = barFloorFaces({ widths: measured, room,");
    expect(bar).toContain("widths: faces.widths,");
    expect(bar).toContain("const standing = verbs.filter((v) => floor.includes(v.id) || admittedIds.has(v.id));");
  });
  it("the bar-mode mount spans the reading pane, which is what the stretch reads", () => {
    const actions = read("src/ui/MessageActions.tsx");
    const mount = actions.slice(actions.indexOf('mode === "bar"'), actions.indexOf("<GlassActionBar"));
    expect(mount).toContain("left: barRail.left");
    expect(mount).toContain("right: barRail.right");
    expect(actions).toContain("const barRail = readerBarClearance(plan, inPane);");
  });
});

describe("the compact bar keeps its thumb set", () => {
  it("reply · forward · later · aside · resurface stand; the rest are one press away", () => {
    expect(readerVerbPlacement("compact", FACTS).standing).toEqual(["reply", "forward", "later", "aside", "resurface"]);
  });
});
