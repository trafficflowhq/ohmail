/**
 * The posture model, as arithmetic — one pure function from what the platform reports to what
 * the layout needs. Dependency-free on purpose (no react-native import), so the suite drives
 * every device × pose as data; the provider (`index.tsx`) only collects inputs and calls this.
 * Size classes are Material's window classes (compact < 600dp, medium < 840, expanded ≥ 840;
 * height compact < 480), which the foldable prototype and Apple's "two size classes" guidance
 * both land on. The fold arrives as the platform reports it — Android's FoldingFeature,
 * iOS's division reserved regions — or not at all, in which case the Duo aspect heuristic
 * below answers for the one device that needs it.
 */

export type SizeClass = "compact" | "medium" | "expanded";
export type FoldState = "none" | "flat" | "half" | "hard";
export type SplitSide = "full" | "left" | "right";
export type Orientation = "portrait" | "landscape";
export type PlatformName = "ios" | "android";

export interface HingeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One fold, as the platform states it. Android: a FoldingFeature verbatim (FLAT | HALF_OPENED,
 * HORIZONTAL | VERTICAL, occlusionType FULL = a hard hinge). iOS: a division reserved region,
 * mapped to the same shape by the native module (`modules/ohmail-posture`).
 */
export interface FoldFeature {
  /** Window coordinates, dp. */
  bounds: HingeRect;
  state: "flat" | "half";
  orientation: "horizontal" | "vertical";
  /** A full occlusion is hardware between two screens (Surface Duo 2) — fold: "hard". */
  occlusion: "none" | "full";
}

export interface Posture {
  sizeClass: SizeClass;
  /** The vertical twin — a landscape phone is medium × compact, and one pane. */
  heightClass: SizeClass;
  panes: 1 | 2;
  fold: FoldState;
  /** The hinge band in window coordinates, or null where no fold crosses this window. */
  hinge: HingeRect | null;
  /** Split-screen multitasking: which half of the screen the app occupies. */
  split: SplitSide;
  orientation: Orientation;
  /**
   * The device HAS a fold, whatever today's pose — a closed Duo reports its inactive division
   * region (`includeInactive`), and that is what sends the nav to the right edge on the outer
   * display while a plain iPhone keeps the bottom dock.
   */
  hasFold: boolean;
  /**
   * The Duo's OUTER display, either way up: the hardware has a fold, none crosses this window
   * and both sides fit the closed panel — one pane with the side rail whatever the width class
   * says (Apple: "on outer displays in landscape, controls remain at the side").
   */
  outer: boolean;
}

export interface PostureInput {
  width: number;
  height: number;
  platform: PlatformName;
  /** null = the fold API is absent (old SDK, plain device, tests) — an answer, not an error. */
  folds: readonly FoldFeature[] | null;
  /** From the inactive-regions probe: the hardware exists even when no fold is active. */
  hasFold?: boolean;
  /** Platform.isPad — the veto on the Duo heuristic; a pad is never read as a foldable. */
  isPad?: boolean;
  /**
   * Window-vs-screen, for split detection: the window's x and width against the screen's
   * width, same units. Absent = no reading, which derives `split: "full"`.
   */
  windowBounds?: { x: number; w: number; screenW: number } | null;
}

export const sizeClassOf = (w: number): SizeClass =>
  w < 600 ? "compact" : w < 840 ? "medium" : "expanded";
export const heightClassOf = (h: number): SizeClass =>
  h < 480 ? "compact" : h < 900 ? "medium" : "expanded";

/**
 * The Duo aspect heuristic, from the prototype's `?real` mode: an iOS window with both sides
 * squarer than 1.5:1 is read as the unfolded Duo, and with no fold reported the hinge is
 * assumed at the centre — vertical in landscape (Apple's Mail shape), horizontal in inner
 * portrait. It only runs where the API is ABSENT, and never for an iPad: the prototype's own
 * warning was "an iPad in a narrow window could match it", and the smallest iPad (744×1133) is
 * measurably larger than the Duo's inner display (669×951) — hence the 700/1000 bound, with
 * `isPad` (Platform.isPad, the provider's reading) as the hard veto.
 */
export function duoHeuristic(w: number, h: number): FoldFeature | null {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (short < 500) return null; // a phone, not an inner display
  if (short > 700 || long > 1000) return null; // an iPad, not a Duo
  if (long / short >= 1.5) return null;
  const vertical = w >= h;
  const band = 9; // the viewport-segment gap the prototype's real Duo reading showed
  return vertical
    ? { bounds: { x: (w - band) / 2, y: 0, w: band, h }, state: "flat", orientation: "vertical", occlusion: "none" }
    : { bounds: { x: 0, y: (h - band) / 2, w, h: band }, state: "flat", orientation: "horizontal", occlusion: "none" };
}

/** The closed Duo is 466×678 either way up; the inner display's long side (951) is well past this. */
export const OUTER_FACE_MAX = 700;

export function derivePosture(input: PostureInput): Posture {
  const { width: w, height: h, platform } = input;
  const orientation: Orientation = w >= h ? "landscape" : "portrait";
  const sizeClass = sizeClassOf(w);
  const heightClass = heightClassOf(h);

  /* The fold: the platform's answer, else (iOS, API absent) the aspect heuristic. */
  let feature: FoldFeature | null = null;
  if (input.folds !== null && input.folds.length > 0) {
    feature = input.folds[0];
  } else if (input.folds === null && platform === "ios" && input.isPad !== true) {
    feature = duoHeuristic(w, h);
  }

  const fold: FoldState =
    feature === null
      ? "none"
      : feature.occlusion === "full"
        ? "hard"
        : feature.state === "half"
          ? "half"
          : "flat";
  const hinge = feature === null ? null : feature.bounds;
  const hasFold = input.hasFold === true || feature !== null;
  const outer =
    platform === "ios" && input.hasFold === true && feature === null && Math.max(w, h) <= OUTER_FACE_MAX;

  /* Split-screen: the window is one half of a wider screen. The side is which edge it hugs. */
  let split: SplitSide = "full";
  const wb = input.windowBounds ?? null;
  if (wb !== null && wb.screenW - wb.w > 40) {
    split = wb.x + wb.w / 2 <= wb.screenW / 2 ? "left" : "right";
  }

  /* Panes, the prototype's own rule: compact width — or a compact height under 440 — is one
     pane; a split window is one pane; everything else holds two. A half-open horizontal fold
     (tabletop) is two panes stacked, which the width rule already admits. */
  const onePane =
    split !== "full" || outer || sizeClass === "compact" || (heightClass === "compact" && h < 440);

  return {
    sizeClass,
    heightClass,
    panes: onePane ? 1 : 2,
    fold,
    hinge,
    split,
    orientation,
    hasFold,
    outer,
  };
}

/**
 * The status bar's frame, classified: a CLUSTER is a narrow, tall frame at the window's side —
 * the closed Duo's time · wifi · camera column the rail starts below; a full-width bar is the
 * ordinary status bar, already counted in the top inset, so it answers null.
 */
export function statusClusterOf(
  frame: { x: number; y: number; width: number; height: number } | null,
  windowW: number,
): { bottom: number } | null {
  if (frame === null) return null;
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (frame.width > windowW / 2) return null; // a bar across the top, not a side cluster
  if (frame.height < 40) return null; // too short to be the cluster
  return { bottom: frame.y + frame.height };
}

/* ─────────────────────────────── the OHMAIL_POSTURE debug override ─────────────────────── */

/**
 * A named pose a test run can force on any simulator, or raw JSON of {@link PostureInput}
 * without `platform` (the runtime supplies it). Three doors, first answer wins: the provider
 * prop (tests), `EXPO_PUBLIC_OHMAIL_POSTURE` at bundle time, the native launch reading
 * (`SIMCTL_CHILD_OHMAIL_POSTURE=…` on the iOS simulator, `adb shell am start … --es
 * OHMAIL_POSTURE …` on Android).
 */
export type PostureOverride = Omit<PostureInput, "platform"> & {
  platform?: PlatformName;
  /**
   * `<preset>@canvas`: the app root renders at the pose's own width × height, scaled to fit the
   * real window — the open face measured on a simulator that cannot open (the closed Duo shows
   * the unfolded layout at 0.49, an iPad 13-inch at 1:1). The safe-area insets inside the
   * canvas are the pose's, not the device's (`insets`, else the platform's default).
   */
  canvas?: boolean;
  insets?: { top: number; right: number; bottom: number; left: number };
};

const duoV = (w: number, h: number, state: "flat" | "half"): FoldFeature => ({
  bounds: { x: (w - 9) / 2, y: 0, w: 9, h },
  state,
  orientation: "vertical",
  occlusion: "none",
});
const duoH = (w: number, h: number, state: "flat" | "half"): FoldFeature => ({
  bounds: { x: 0, y: (h - 9) / 2, w, h: 9 },
  state,
  orientation: "horizontal",
  occlusion: "none",
});

/**
 * The named poses — the prototype's device table, in dp. Duo outer 466×678 (each inner half
 * matches the outer panel), inner 951×669 landscape; Fold inner ~841×701; Flip 412×919 with
 * its tabletop; phone 390×844; iPad 1180×820.
 */
export const POSTURE_PRESETS: Record<string, PostureOverride> = {
  phone: { width: 390, height: 844, folds: null, hasFold: false },
  "phone-landscape": { width: 844, height: 390, folds: null, hasFold: false },
  "duo-closed": { width: 466, height: 678, folds: [], hasFold: true, platform: "ios" },
  "duo-closed-landscape": { width: 678, height: 466, folds: [], hasFold: true, platform: "ios" },
  "duo-unfolded": { width: 951, height: 669, folds: [duoV(951, 669, "flat")], hasFold: true, platform: "ios" },
  "duo-book": { width: 951, height: 669, folds: [duoV(951, 669, "half")], hasFold: true, platform: "ios" },
  "duo-unfolded-portrait": { width: 669, height: 951, folds: [duoH(669, 951, "flat")], hasFold: true, platform: "ios" },
  "duo-tabletop": { width: 669, height: 951, folds: [duoH(669, 951, "half")], hasFold: true, platform: "ios" },
  "duo-split-left": {
    width: 471, height: 669, folds: [], hasFold: true, platform: "ios",
    windowBounds: { x: 0, w: 471, screenW: 951 },
  },
  "duo-split-right": {
    width: 471, height: 669, folds: [], hasFold: true, platform: "ios",
    windowBounds: { x: 480, w: 471, screenW: 951 },
  },
  "fold-inner": {
    width: 841, height: 701, platform: "android", hasFold: true,
    folds: [{ bounds: { x: 418, y: 0, w: 5, h: 701 }, state: "flat", orientation: "vertical", occlusion: "none" }],
  },
  "fold-book": {
    width: 841, height: 701, platform: "android", hasFold: true,
    folds: [{ bounds: { x: 418, y: 0, w: 5, h: 701 }, state: "half", orientation: "vertical", occlusion: "none" }],
  },
  flip: { width: 412, height: 919, folds: [], hasFold: true, platform: "android" },
  "flip-tabletop": {
    width: 412, height: 919, platform: "android", hasFold: true,
    folds: [{ bounds: { x: 0, y: 455, w: 412, h: 9 }, state: "half", orientation: "horizontal", occlusion: "none" }],
  },
  ipad: { width: 1180, height: 820, folds: null, hasFold: false, isPad: true, platform: "ios" },
  "ipad-portrait": { width: 820, height: 1180, folds: null, hasFold: false, isPad: true, platform: "ios" },
  "android-tablet": { width: 1280, height: 800, folds: null, hasFold: false, platform: "android" },
  sd2: {
    width: 1110, height: 757, platform: "android", hasFold: true,
    folds: [{ bounds: { x: 538, y: 0, w: 34, h: 757 }, state: "flat", orientation: "vertical", occlusion: "full" }],
  },
};

/** Parse the override string: a preset name, else JSON. A bad value is null — live wins. */
export function parsePostureOverride(raw: string | null | undefined): PostureOverride | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  /* `<name>@canvas` — the flag rides the preset name so one launch env carries both. */
  const at = s.indexOf("@");
  const name = at === -1 ? s : s.slice(0, at);
  const flags = at === -1 ? [] : s.slice(at + 1).split("@");
  const canvas = flags.includes("canvas");
  const preset = POSTURE_PRESETS[name];
  if (preset !== undefined) return canvas ? { ...preset, canvas: true } : preset;
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.width !== "number" || typeof o.height !== "number") return null;
    return o as unknown as PostureOverride;
  } catch {
    return null;
  }
}
