/**
 * ═══ A FOLDABLE'S SCREENS FIT THE WINDOW THEY ARE GIVEN ═════════════════════════════════════════
 *
 * Four defects a device sweep of the released Android app read on a book-style foldable: the New
 * mail sheet outgrew the cover screen held sideways and left Send below it; the rail covered the
 * first letters of every single-pane route under a two-pane posture; the reading pane's title
 * started inside the status bar; a long attachment name ran its tile past the screen's edge. No
 * React Native renderer here, so each is measured where it is decided — the arithmetic as data,
 * the layout props in the source — beside the one line a device run reads for the posture.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { installEngineLogWriter, logPostureDerived, type EngineLogLevel } from "../src/engine/engine-log";
import { derivePosture, type FoldFeature } from "../src/ui/posture/derive";
import { composeBodyMin, letterRunsOn, notesMeasured, notesPinned, pinnedNotesMax } from "../src/ui/compose-fit";
import { RAIL_W, scaffoldPlan, screenFillsWindow, screenRailClearance } from "../src/ui/scaffold/plan";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

/** A book-style foldable's inner screen, flat or half open: a vertical fold down the middle. */
const inner = (width: number, height: number, state: FoldFeature["state"]) =>
  derivePosture({
    platform: "android",
    width,
    height,
    folds: [{ bounds: { x: width / 2, y: 0, w: 0, h: height }, state, orientation: "vertical", occlusion: "none" }],
    hasFold: true,
  });

describe("the New mail sheet keeps Send on screen", () => {
  const body = src("../src/ui/MessageActions.tsx");
  const sheet = body.slice(body.indexOf("export function ComposeSheet("));
  const modal = sheet.slice(sheet.indexOf("onRequestClose={closeComposer}"));
  const open = modal.indexOf("<ScrollView");
  const close = modal.lastIndexOf("</ScrollView>", modal.indexOf("<Button label={Copy.replyCancel}"));

  it("the fields scroll inside the panel", () => {
    expect(open, "the composer's panel has no scroller").toBeGreaterThan(-1);
    for (const field of ["setTo)", "setSubject)", "setBody)"]) {
      const at = modal.indexOf(`onChangeText={editWhileIdle(phase, ${field}}`);
      expect(at, `${field} moved; this reads nothing`).toBeGreaterThan(-1);
      expect(at > open && at < close, `${field} is outside the scroller`).toBe(true);
    }
  });

  it("the scroller gives way and the panel gives way, so the footer never leaves the window", () => {
    expect(modal.slice(open, modal.indexOf(">", open))).toContain("style={{ flexGrow: 0, flexShrink: 1 }}");
    const panel = modal.slice(0, open);
    expect(panel.slice(panel.lastIndexOf("borderTopLeftRadius"))).toContain("flexShrink: 1,");
  });

  it("Send and Cancel stand after the scroller and are the only thing always pinned", () => {
    for (const needle of ["<Button label={Copy.replyCancel}", "Copy.replySend"]) {
      const at = modal.indexOf(needle);
      expect(at, `${needle} moved; this reads nothing`).toBeGreaterThan(-1);
      expect(at, `${needle} scrolls away with the fields`).toBeGreaterThan(close);
    }
    const between = modal.slice(close, modal.indexOf("<Button label={Copy.replyCancel}"));
    expect(between, "a sentence pinned outside the bounded block").not.toMatch(/<Txt\b/);
    expect(between).toContain("{pinNotes ? notesBlock : null}");
    expect(modal.slice(open, close)).toContain("{pinNotes ? null : notesBlock}");
  });

  it("every sentence answering a press is in the bounded block, and the scroller's edge is drawn", () => {
    const notes = sheet.slice(sheet.indexOf("const noteItems = ["), sheet.indexOf("const notesBlock"));
    for (const needle of [
      "Copy.replyAlreadySent", "failedSendLine(", "Copy.composeNeedContent", "Copy.composeKeepFailed",
      "connectionSaid(w.boot.connection)",
    ]) expect(notes, `${needle} is not in the bounded block`).toContain(needle);
    // The why-no-Send-later hints explain a control, not a press: they end the letter, in the scroller.
    for (const needle of ["scheduledNotHereSentence(", "{Copy.sendLaterUnavailable}"]) {
      expect(modal.slice(open, close), `${needle} takes pinned room`).toContain(needle);
      expect(notes).not.toContain(needle);
    }
    expect(sheet).toContain("const pinNotes = notesPinned(notesHeight, pinnedNotesMax(windowHeight));");
    const edge = modal.slice(close, close + 300);
    expect(edge).toContain("height: StyleSheet.hairlineWidth * 2, marginTop: -10, backgroundColor: t.c.hairSoft");
    expect(sheet).toContain("minHeight: composeBodyMin(later !== null, heightClass),");
  });
});

describe("the composer's heights on a short window", () => {
  it("the writing area falls to about three lines at compact height, and to one beside the picker", () => {
    expect(composeBodyMin(false, "compact")).toBe(84);
    expect(composeBodyMin(false, "medium")).toBe(120);
    expect(composeBodyMin(true, "compact")).toBe(44);
  });
  it("the pinned sentences are bounded by a fifth of the window, at most 96 dp, and scroll past it", () => {
    expect(pinnedNotesMax(403)).toBe(81);
    expect(pinnedNotesMax(905)).toBe(96);
    expect(notesPinned(null, 81), "a first sentence lands by the buttons").toBe(true);
    expect(notesPinned(81, 81)).toBe(true);
    expect(notesPinned(82, 81)).toBe(false);
  });
  /* A tall block measured, every sentence cleared, then one short sentence: it drew at the letter's
     end for a frame on the old height before it measured and moved back over the buttons. */
  it("once every sentence clears, the next one is unmeasured and lands by the buttons", () => {
    const max = pinnedNotesMax(403);
    expect(notesPinned(notesMeasured(200, 0), max)).toBe(true);
    expect(notesPinned(notesMeasured(200, 2), max), "CONTROL: a block still standing keeps its height").toBe(false);
  });
  /* On the cover held sideways the why-no-Send-later sentence sat below the hair line with no cue. */
  it("a letter that runs on below the scroller's edge says so; at its end it does not", () => {
    expect(letterRunsOn(400, 160, 0)).toBe(true);
    expect(letterRunsOn(400, 160, 238)).toBe(true);
    expect(letterRunsOn(400, 160, 239), "a rounding step from the end is the end").toBe(false);
    expect(letterRunsOn(400, 160, 240), "scrolled to the end").toBe(false);
    expect(letterRunsOn(150, 160, 0), "it all fits").toBe(false);
    expect(letterRunsOn(0, 0, 0), "unmeasured").toBe(false);
  });
  it("on the cover held sideways under a 200 dp keyboard, the pinned part fits what is left", () => {
    // ASSUMED: a keyboard that does not go full screen and stands 200 dp tall, half the 403 dp cover.
    // The panel: top padding 16, the bounded sentences, two 10 dp gaps (sentences, buttons; the hair
    // line's -10 cancels the scroller's), one button row (~50), bottom padding 12 + a 24 dp inset.
    const left = 403 - 200;
    expect(16 + pinnedNotesMax(403) + 10 + 10 + 50 + 12 + 24).toBeLessThanOrEqual(left);
  });
});

describe("a page with its own heading renders no app-bar title", () => {
  const routes = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) routes(full, out);
      else if (name.endsWith(".tsx")) out.push(full);
    }
    return out;
  };
  /** Every titled bar whose own Screen draws an h1 of the same expression — a literal or a variable. */
  const duplicateTitles = (src: string): string[] => {
    const body = withoutComments(src);
    const twice: string[] = [];
    for (const m of body.matchAll(/<DetailBar title=\{([^}]+)\} \/>/g)) {
      const screen = body.slice(m.index!, body.indexOf("</Screen>", m.index!));
      for (const h of screen.matchAll(/<Txt variant="h1"[^>]*>\s*\{([^}]+)\}\s*<\/Txt>/g)) {
        if (h[1]!.trim() === m[1]!.trim()) twice.push(m[1]!.trim());
      }
    }
    return twice;
  };
  const files = routes(fileURLToPath(new URL("../app", import.meta.url)));
  it("the census reads a literal and a variable title alike (planted routes)", () => {
    const literal = `<Screen>\n<DetailBar title={Copy.settings} />\n<Txt variant="h1">{Copy.settings}</Txt>\n</Screen>`;
    const variable = `<Screen>\n<DetailBar title={tag.name} />\n<Txt variant="h1" numberOfLines={1}>\n  {tag.name}\n</Txt>\n</Screen>`;
    expect(duplicateTitles(literal)).toEqual(["Copy.settings"]);
    expect(duplicateTitles(variable)).toEqual(["tag.name"]);
    expect(duplicateTitles(variable.replace("<DetailBar title={tag.name} />", "<DetailBar />")), "the admitted shape").toEqual([]);
  });
  it("no route titles its bar with the heading its page draws below it (DUPLICATE_TITLE)", () => {
    expect(files.length, "the route walk read nothing").toBeGreaterThan(20);
    let bars = 0;
    const twice: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      bars += (withoutComments(src).match(/<DetailBar title=/g) ?? []).length;
      for (const t of duplicateTitles(src)) twice.push(`${f}: ${t}`);
    }
    expect(bars, "no titled bar left; this census reads nothing").toBeGreaterThan(5);
    expect(twice).toEqual([]);
  });
});

describe("a single-pane route under a two-pane posture starts past the rail", () => {
  const postures = {
    "unfolded portrait": inner(821, 905, "flat"),
    "unfolded landscape": inner(905, 821, "flat"),
    "unfolded at 480 dpi": inner(719, 792, "flat"),
    "half open": inner(821, 905, "half"),
  };
  for (const [name, posture] of Object.entries(postures)) {
    it(`${name}: Settings, Search, More and the composer pay the column the pair pays`, () => {
      const plan = scaffoldPlan(posture, "android");
      expect(plan.panes, "not a two-pane posture; this measures nothing").toBe(2);
      expect(plan.nav).toBe("rail");
      const alone = screenRailClearance(plan, screenFillsWindow(undefined, false));
      expect(alone).toEqual({ left: RAIL_W + plan.gutter, right: 0 });
      expect(screenRailClearance(plan, screenFillsWindow(undefined, true)), "a pane of the pair pays twice").toEqual({ left: 0, right: 0 });
    });
  }

  it("what a screen says outranks where it stands", () => {
    expect(screenFillsWindow(false, false)).toBe(false);
    expect(screenFillsWindow(true, true)).toBe(true);
  });

  it("the pair marks both panes and pays the rail once", () => {
    const pair = src("../src/ui/list-detail.tsx");
    const twoPane = pair.slice(pair.indexOf("const listPane ="));
    /* The list is a pane only while the pair shows it beside a reader; the reader's slot always is. */
    expect(twoPane).toContain('<InPaneContext.Provider value={show === "pair"}>');
    expect(twoPane.match(/<InPaneContext\.Provider value>/g)?.length, "a pane the Screen inside it does not know about").toBe(1);
    expect(twoPane).toContain('<Screen fullWindow={show === "reader"}');
    const screen = src("../src/ui/base.tsx");
    expect(screen).toContain("const fills = screenFillsWindow(fullWindow, inPane);");
    expect(screen).toContain("const rail = screenRailClearance(plan, fills, inPane, useNavDrawn());");
  });
});

describe("a pane without a bar still clears the status bar", () => {
  it("the bar-less top pays the inset", () => {
    const chrome = src("../src/ui/chrome.tsx");
    const at = chrome.indexOf("export function PaneTop()");
    const fn = chrome.slice(at, chrome.indexOf("\n}\n", at));
    expect(fn).toContain("const top = useTopPad(0);");
    expect(fn).toContain("paddingTop: top");
  });
  it("the reader and the sender page render it wherever they drop their bar", () => {
    const reader = src("../src/ui/MessageReader.tsx");
    expect(reader.match(/\{bare \? <PaneTop \/> : /g)?.length).toBe(2);
    const sender = src("../src/ui/SenderDetail.tsx");
    expect(sender.match(/\{inPane \? <PaneTop \/> : <DetailBar/g)?.length).toBe(2);
    for (const [name, s] of [["MessageReader", reader], ["SenderDetail", sender]] as const) {
      expect(s, `${name} drops its bar and its inset with it`).not.toMatch(/\{(?:bare|inPane) \? null : (?:\(\s*)?<DetailBar/);
    }
  });
});

describe("an attachment tile never runs past its line", () => {
  const reader = src("../src/ui/MessageReader.tsx");
  const tiles = reader.slice(reader.indexOf("export function AttachmentTiles("));
  it("the tile is bounded by the row and gives way inside it", () => {
    expect(tiles).toContain('<View key={a.id} style={{ maxWidth: "100%", flexShrink: 1 }}>');
    const tap = tiles.slice(tiles.indexOf("<Tap"), tiles.indexOf("</Tap>"));
    expect(tap).toContain('maxWidth: "100%",');
  });
  it("the name ellipsizes in the middle, so the extension stays; the size never shrinks", () => {
    const tap = tiles.slice(tiles.indexOf("<Tap"), tiles.indexOf("</Tap>"));
    expect(tap).toContain('<Txt variant="button" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>');
    expect(tap).toMatch(/<Txt variant="caption" tone="ink3" style=\{\{ flexShrink: 0 \}\}>\s*\{a\.size\}/);
  });
});

describe("the posture the app derives is said in the engine's log", () => {
  const seen: { level: EngineLogLevel; line: string }[] = [];
  const record = () => {
    seen.length = 0;
    installEngineLogWriter({ write: (level, line) => void seen.push({ level, line }) });
  };
  afterEach(() => installEngineLogWriter(null));

  it("one closed-shape line: the window in whole dp, the folds reported, the fold state", () => {
    record();
    logPostureDerived({ width: 821.3333, height: 904.6, folds: 1, state: "flat" });
    expect(seen).toEqual([
      { level: "info", line: '{"service":"app","event":"posture_derived","width":821,"height":905,"folds":1,"state":"flat"}' },
    ]);
  });
});
