/**
 * Blanc typography for React Native. One well-tuned system sans at fixed px sizes; `typography.family.ui`
 * leads with `-apple-system`, so RN's default family IS the token — no font is bundled. Size translates
 * exactly (RN `fontSize` is dp, CSS px at 1×; the 10.5–15.5 reading roles carry `PHONE_STEP`, nothing at 16+
 * moves). Leading translates exactly (`size × multiplier`). Weight is the one lossy step: Blanc's
 * 450/500/550/600/650 compress onto RN's whole hundreds — 450→'400', 500→'500', 550→'600', 600→'600' (the
 * collision), 650→'700'. 550 and 600 land together because those roles never meet on one line; folding
 * 600↔650 would flatten the wordmark against row text, folding 450↔500 would thicken body copy.
 * `test/theme.test.ts` pins the table so the compromise cannot quietly move.
 */
import type { TextStyle } from "react-native";
import { typography } from "@ohmail/tokens";
import { design } from "@ohmail/tokens/design";

/** `typography.size` is authored as CSS strings; RN wants points. */
const px = (v: string) => Number(v.replace("px", ""));
const tSize = typography.size;

/**
 * The phone type step — the whole rule, stated where it is applied. The scale was one notch too dense on a
 * phone (sender 13, subject 13.5, preview 12, stamps 11, against Material body-medium 14 and iOS footnote
 * 13), so every reading role from 10.5 through 15.5 moves up exactly one point and the density is otherwise
 * kept — every size stays on the half-point ladder, every hierarchy relation intact. Bounds: nothing at 16
 * and above moves (stepping titles would be a hierarchy redesign); the floor for information-bearing text is
 * 12; text inputs at 16 is a browser rule (Safari zoom) that binds the web shell, not this app; a mark is not
 * text — the wordmark does not step. The web shell reaches the same numbers from the same tokens. One
 * constant: set it to 0 and every size is the token's own number again (`test/theme.test.ts` watches).
 */
export const PHONE_STEP = 1;

/**
 * Px sizes derived from `typography.size`, by role — the reading band plus
 * `PHONE_STEP`, the rest verbatim. The trailing comment on each line is the
 * value this app renders today.
 */
export const size = {
  /** badges, tag chips */ micro: px(tSize.micro) + PHONE_STEP, // 11.5
  /** tab labels, hints, timestamps, waterline */ caption: px(tSize.caption) + PHONE_STEP, // 12
  /** chips, meta labels, small controls */ label: px(tSize.label) + PHONE_STEP, // 12.5
  /** decision buttons, view meta, notes */ bodyS: px(tSize.bodyS) + PHONE_STEP, // 13
  /** buttons, compose CTA, from-line */ control: px(tSize.control) + PHONE_STEP, // 13.5
  /** rows (sender), body copy, settings labels */ body: px(tSize.body) + PHONE_STEP, // 14
  /** subjects, stream/held bodies */ bodyL: px(tSize.bodyL) + PHONE_STEP, // 14.5
  /** root */ base: px(tSize.base) + PHONE_STEP, // 15
  /** reading body, search input */ prose: px(tSize.prose) + PHONE_STEP, // 15.5
  /** wordmark — a mark, not text */ wordmark: px(tSize.wordmark), // 15
  /** reader body — the exhale */ proseReader: px(tSize.proseReader) + PHONE_STEP, // 16.5
  /** focus-reply title, protected code */ h4: px(tSize.h4), // 16
  /** stream-card title */ cardTitle: px(tSize.cardTitle), // 16.5
  /** held-mail title */ heldTitle: px(tSize.heldTitle), // 17
  /** view h1 (mobile — this app's h1) */ h1: px(tSize.h1Mobile), // 22
  /** message subject h2 */ h2: px(tSize.h2), // 24
  /** reader subject */ readerTitle: px(tSize.readerTitle), // 29
} as const;

/**
 * The compression table above, as code. Keys are the CSS weights Blanc
 * authored; values are what RN can actually ask the platform for.
 */
export const weight = {
  /** css 450 */ regular: "400",
  /** css 500 */ medium: "500",
  /** css 550 */ semibold: "600",
  /** css 600 */ bold: "600",
  /** css 650 */ heavy: "700",
} as const satisfies Record<string, TextStyle["fontWeight"]>;

/** Letter-spacing, authored in em; RN wants points, so `em × size`. */
export const tracking = {
  /** view h1 / message h2 */ display: -0.025,
  /** wordmark */ wordmark: -0.02,
  /** card titles */ title: -0.015,
  /** pile headings, topbar */ heading: -0.01,
  /** row subjects */ subject: -0.008,
  /** row sender names */ name: -0.005,
  /** protected verification code */ code: 0.18,
} as const;

/** CSS line-height multipliers. */
export const leading = {
  /** message h2 */ tight: 1.25,
  /** card titles */ heading: 1.3,
  /** notes, decision consequence line */ snug: 1.45,
  /** base */ base: 1.5,
  /** hints, small prose */ relaxed: 1.55,
  /** compose editor, inputs */ input: 1.65,
  /** stream / held bodies */ body: 1.7,
  /** reading body */ prose: 1.72,
  /** reader body — the exhale */ reader: 1.78,
} as const;

interface TypeSpec {
  size: number;
  weight: TextStyle["fontWeight"];
  /** em */
  tracking?: number;
  /** multiplier */
  leading?: number;
}

function t({ size: s, weight: w, tracking: tr, leading: le }: TypeSpec): TextStyle {
  const style: TextStyle = { fontSize: s, fontWeight: w };
  if (tr !== undefined) style.letterSpacing = s * tr;
  if (le !== undefined) style.lineHeight = Math.round(s * le * 100) / 100;
  return style;
}

/**
 * Named presets for the roles that recur across screens — the same set the
 * retired macOS port carried, so a role means one thing on every surface.
 */
export const type = {
  wordmark: t({ size: size.wordmark, weight: weight.heavy, tracking: tracking.wordmark }),
  h1: t({ size: size.h1, weight: weight.bold, tracking: tracking.display }),
  h2: t({ size: size.h2, weight: weight.bold, tracking: tracking.display, leading: leading.tight }),
  streamTitle: t({ size: size.h2, weight: weight.bold, tracking: tracking.display, leading: leading.tight }),
  readerTitle: t({
    size: size.readerTitle,
    weight: weight.bold,
    tracking: tracking.display,
    leading: leading.tight,
  }),
  cardTitle: t({
    size: size.cardTitle,
    weight: weight.bold,
    tracking: tracking.title,
    leading: leading.heading,
  }),
  heldTitle: t({
    size: size.heldTitle,
    weight: weight.bold,
    tracking: tracking.title,
    leading: leading.heading,
  }),
  rowSender: t({ size: size.body, weight: weight.bold, tracking: tracking.name }),
  rowSenderSeen: t({ size: size.body, weight: weight.medium, tracking: tracking.name }),
  rowSubject: t({ size: size.bodyL, weight: weight.medium, tracking: tracking.subject }),
  rowSubjectSeen: t({ size: size.bodyL, weight: weight.regular, tracking: tracking.subject }),
  body: t({ size: size.body, weight: weight.regular, leading: leading.base }),
  bodyMedium: t({ size: size.body, weight: weight.semibold, leading: leading.base }),
  msgBody: t({ size: size.prose, weight: weight.regular, leading: leading.prose }),
  readerBody: t({ size: size.proseReader, weight: weight.regular, leading: leading.reader }),
  streamBody: t({ size: size.bodyL, weight: weight.regular, leading: leading.body }),
  meta: t({ size: size.bodyS, weight: weight.regular }),
  note: t({ size: size.bodyS, weight: weight.regular, leading: leading.snug }),
  caption: t({ size: size.caption, weight: weight.regular }),
  tabLabel: t({ size: size.caption, weight: weight.semibold, tracking: tracking.name }),
  navLabel: t({ size: size.body, weight: weight.regular }),
  railLabel: t({ size: size.body, weight: weight.semibold }),
  railCount: t({ size: size.bodyS, weight: weight.bold }),
  navLabelOn: t({ size: size.body, weight: weight.bold }),
  chip: t({ size: size.label, weight: weight.regular, leading: leading.relaxed }),
  tagchip: t({ size: size.micro, weight: weight.bold }),
  badge: t({ size: size.micro, weight: weight.medium }),
  button: t({ size: size.control, weight: weight.semibold }),
  decision: t({ size: size.bodyS, weight: weight.semibold }),
  /* THE AI'S SUGGESTED DESTINATION IS `decision` IN THE HEAVY GRADE, NOT A SMALLER ROLE.
     The web marks the suggestion by ring, accent and weight 650 at the SAME size as the
     siblings it sits beside (`split-button.css:6,14,16`) — the mark is the emphasis, and the
     size is what keeps the row one row. This site used to reach that emphasis by borrowing
     `pileTitle` and pulling it back down with an inline `fontSize: 12`, which left it one
     point UNDER the neighbouring `decision` at 13 and carried `pileTitle`'s tracking. */
  decisionAi: t({ size: size.bodyS, weight: weight.heavy }),
  /* A HINT IS A CAPTION THAT WRAPS. `caption` carries no leading because the roles it was
     drawn for — a row's timestamp, a tab label — are single lines, and a multi-line caption
     then falls back to the platform's own line box (~1.33 at 12). The web's hints run 1.5
     (`settings.css:65`), so the explanatory captions under a control take that here. */
  hint: t({ size: size.caption, weight: weight.regular, leading: leading.base }),
  pileTitle: t({ size: size.bodyL, weight: weight.heavy, tracking: tracking.heading }),
  settingsLabel: t({ size: size.body, weight: weight.bold }),
  sectionLabel: t({ size: size.bodyS, weight: weight.bold, tracking: tracking.name }),
  protectedCode: t({ size: size.h4, weight: weight.medium, tracking: tracking.code }),
} as const;

/** Paper's display and mail text roles, applied only inside the mail routes. */
const paper = design.faces.paper.light;
const paperTouch = design.faces.paper.touch;
const ui = px(paper["t-ui"]);
const meta = px(paper["t-meta"]);
const reading = px(paper["t-read"]);
const title = px(paper["t-title"]);
const line = Number(paper["lh-read"]);
const text = (size: number, weight: TextStyle["fontWeight"], leading = 1.4) =>
  t({ size, weight, leading });

export const paperMailType = {
  railLabel: text(ui, "600"),
  railCount: text(meta, "700"),
  h1: { ...text(title + 2, "800", 1.18), letterSpacing: -0.45 },
  h2: { ...text(title + 2, "800", 1.18), letterSpacing: -0.45 },
  streamTitle: t({
    size: px(paperTouch["t-title"]),
    weight: paperTouch["w-display"],
    tracking: Number.parseFloat(paperTouch.track),
    leading: 1.2,
  }),
  readerTitle: { ...text(title + 2, "800", 1.18), letterSpacing: -0.45 },
  cardTitle: { ...text(title, "800", 1.18), letterSpacing: -0.4 },
  heldTitle: text(title, "800", 1.2),
  rowSender: text(ui, "700"),
  rowSenderSeen: text(ui, "400"),
  rowSubject: text(ui, "700"),
  rowSubjectSeen: text(ui, "400"),
  body: text(ui, "400"),
  bodyMedium: text(ui, "600"),
  msgBody: text(reading, "400", line),
  readerBody: text(reading, "400", line),
  streamBody: text(reading, "400", line),
  meta: text(meta, "400"),
  note: text(meta, "400", 1.5),
  caption: text(meta, "400"),
  button: text(ui, "700", 1.2),
  sectionLabel: text(px(paper["t-group"]), "800"),
} as const;

/** The asset aliases name instances at the weights Paper uses, so Android retains the weight. */
export function nativePaperType(presets: typeof type): typeof type {
  const roles = { ...presets };
  for (const key of Object.keys(roles) as TypeRole[]) {
    const style = roles[key];
    const weight = style.fontWeight ?? "400";
    const family = key === "protectedCode" ? `PaperMono${weight}`
      : weight === "800" ? "PaperDisplay" : `PaperBody${weight}`;
    roles[key] = { ...style, fontFamily: family, fontWeight: undefined };
  }
  return roles;
}

export type TypeRole = keyof typeof type;

/**
 * THE DOCK BADGE AT A TEXT SCALE: its digits' style and the pill's height, from one number. The pill
 * used to be a fixed 16 around digits the OS scaled, so at iOS Accessibility XL they were cut at the
 * top and at Android font 2.0 they printed below it. The scale is capped: a count that grew as far as
 * body text would cover the 44pt button's icon. The OS scales nothing on top (`allowFontScaling`).
 */
export const BADGE_SCALE_CAP = 1.5;
const BADGE_RING = 1.5;

export function badgeAtScale(fontScale: number): { text: TextStyle; height: number } {
  const s = Number.isFinite(fontScale) ? Math.min(Math.max(fontScale, 1), BADGE_SCALE_CAP) : 1;
  const fontSize = Math.round(size.micro * s * 10) / 10;
  const lineHeight = Math.ceil(fontSize * 1.2);
  return { text: { fontSize, lineHeight }, height: Math.max(16, lineHeight + 2 * BADGE_RING) };
}

export function onboardingDisplay(type: Readonly<Record<"t-head" | "t-display", string>>, compact = false) {
  const fontSize = px(type[compact ? "t-head" : "t-display"]);
  return { fontSize, lineHeight: fontSize * 1.07, fontWeight: "800" as const, letterSpacing: -fontSize * 0.022 };
}

export function onboardingTagType(type: Readonly<Record<"t-ui", string>>, large = false): TextStyle {
  return { fontSize: large ? px(type["t-ui"]) : size.bodyS, fontWeight: "600" };
}

export const onboardingType = {
  button: { fontSize: size.h4, lineHeight: 20, fontWeight: "700" },
  body: { fontSize: size.h4, lineHeight: 22 },
  wallBody: { fontSize: size.h4, lineHeight: 23 },
  label: { fontSize: size.h4 },
  dot: { fontSize: 9 },
  provider: { fontSize: size.h2 },
} as const;
