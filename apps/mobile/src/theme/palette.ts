/**
 * The Blanc colour scheme for React Native — one palette per appearance.
 *
 * Every value is the verbatim OKLCH from `packages/tokens/src/tokens.ts`, run
 * through `oklch.ts`. The trailing `//` on each line records the sRGB hex it
 * resolves to — the convention the retired macOS client's palette established —
 * so a reviewer can eyeball fidelity across platforms without
 * running a converter, and `test/theme.test.ts` fails if any of them drifts.
 *
 *   TOKEN                     OKLCH (L C H / a)              -> sRGB hex
 *   ─────────────────────────────────────────────────────────────────────
 */
import { DEFAULT_FACE, type FaceName } from "./face";
import { css, oklch, type Oklch } from "./oklch";
import { ohmarchyPalettes } from "./ohmarchy";

export type SchemeName = "light" | "dark";
export type TagHueName = "moss" | "ochre" | "rosewood";

/** One tag hue: chip ink + translucent chip background. */
export interface TagPalette {
  readonly ink: string;
  readonly bg: string;
}

export interface Palette {
  readonly scheme: SchemeName;
  readonly canvas: string;
  readonly panel: string;
  readonly float: string;
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly hair: string;
  readonly hairSoft: string;
  readonly tint: string;
  readonly tint2: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly accentSoft: string;
  readonly accentHair: string;
  readonly onAccent: string;
  readonly scrim: string;
  readonly tag: Readonly<Record<TagHueName, TagPalette>>;
}

/** The authored OKLCH, kept so tests can re-derive rather than trust a string. */
export const authored: Record<SchemeName, Record<string, Oklch>> = {
  light: {
    canvas: oklch(0.985, 0.002, 85), //                #fbfaf9  page canvas, a hair off white
    panel: oklch(1, 0, 0), //                          #ffffff  resting panel surface
    float: oklch(1, 0, 0), //                          #ffffff  floating surface (dock, sheet, reader)
    ink: oklch(0.245, 0.012, 60), //                   #251f1b  primary text
    ink2: oklch(0.42, 0.015, 60), //                   #534b45  secondary text
    ink3: oklch(0.47, 0.016, 62), //                   #625952  tertiary text (meta, hints)
    hair: oklch(0.3, 0.02, 60, 0.16), //               #362c24 @.16  functional hairline
    hairSoft: oklch(0.3, 0.02, 60, 0.09), //           #362c24 @.09  dividers, waterline
    tint: oklch(0.5, 0.05, 60, 0.05), //               #795d46 @.05  pressed / resting wash
    tint2: oklch(0.5, 0.05, 60, 0.09), //              #795d46 @.09  segmented track, badges
    accent: oklch(0.51, 0.135, 42), //                 #a3461c  burnt sienna — primary actions
    accentInk: oklch(0.47, 0.125, 42), //              #923d17  accent tuned for text on surfaces
    accentSoft: oklch(0.6, 0.13, 45, 0.09), //         #be6438 @.09  AI chips, doorbell, protected block
    accentHair: oklch(0.55, 0.13, 45, 0.38), //        #ae5528 @.38  accent ring (AI preselect, focus)
    onAccent: oklch(0.995, 0.004, 85), //              #fffdfa  text/icon on solid accent
    scrim: oklch(0.985, 0.003, 90, 0.74), //           #fbfaf8 @.74  overlay scrim
    tagMossInk: oklch(0.43, 0.07, 150), //             #325b3b  Pottery Project ink
    tagMossBg: oklch(0.55, 0.08, 150, 0.11), //        #4e7f58 @.11
    tagOchreInk: oklch(0.45, 0.09, 78), //             #704e09  Paperwork ink
    tagOchreBg: oklch(0.6, 0.1, 78, 0.14), //          #a17833 @.14
    tagRosewoodInk: oklch(0.45, 0.1, 25), //           #843c38  Adventures ink
    tagRosewoodBg: oklch(0.55, 0.1, 25, 0.11), //      #a45953 @.11
  },
  dark: {
    canvas: oklch(0.152, 0.008, 55), //                #0e0b08  deep warm near-black canvas
    panel: oklch(0.208, 0.01, 55), //                  #1c1714  resting panel (one step up)
    float: oklch(0.25, 0.012, 55), //                  #26201c  floating surface (two steps up)
    ink: oklch(0.932, 0.007, 80), //                   #ebe8e3  primary text
    ink2: oklch(0.72, 0.012, 70), //                   #aaa39d  secondary text
    ink3: oklch(0.63, 0.014, 68), //                   #8f8880  tertiary text
    hair: oklch(0.95, 0.012, 80, 0.14), //             #f3eee6 @.14  functional hairline
    hairSoft: oklch(0.95, 0.012, 80, 0.08), //         #f3eee6 @.08  dividers, waterline
    tint: oklch(0.95, 0.03, 70, 0.05), //              #fcecd9 @.05  pressed wash
    tint2: oklch(0.95, 0.03, 70, 0.09), //             #fcecd9 @.09  segmented track, badges
    accent: oklch(0.75, 0.115, 55), //                 #e69a64  warm sienna, lifted for dark
    accentInk: oklch(0.78, 0.105, 58), //              #eaa672  accent text on dark surfaces
    accentSoft: oklch(0.75, 0.115, 55, 0.12), //       #e69a64 @.12
    accentHair: oklch(0.75, 0.115, 55, 0.42), //       #e69a64 @.42
    onAccent: oklch(0.19, 0.035, 50), //               #200f05  dark ink on the lifted accent
    scrim: oklch(0.11, 0.008, 55, 0.76), //            #060403 @.76
    tagMossInk: oklch(0.8, 0.07, 150), //              #9ecba6
    tagMossBg: oklch(0.75, 0.08, 150, 0.14), //        #8abd93 @.14
    tagOchreInk: oklch(0.82, 0.09, 80), //             #e3be80
    tagOchreBg: oklch(0.78, 0.1, 80, 0.15), //         #d9b06b @.15
    tagRosewoodInk: oklch(0.8, 0.08, 25), //           #edaaa4
    tagRosewoodBg: oklch(0.72, 0.1, 25, 0.15), //      #dc8c85 @.15
  },
};

function build(scheme: SchemeName): Palette {
  const a = authored[scheme];
  return {
    scheme,
    canvas: css(a.canvas),
    panel: css(a.panel),
    float: css(a.float),
    ink: css(a.ink),
    ink2: css(a.ink2),
    ink3: css(a.ink3),
    hair: css(a.hair),
    hairSoft: css(a.hairSoft),
    tint: css(a.tint),
    tint2: css(a.tint2),
    accent: css(a.accent),
    accentInk: css(a.accentInk),
    accentSoft: css(a.accentSoft),
    accentHair: css(a.accentHair),
    onAccent: css(a.onAccent),
    scrim: css(a.scrim),
    tag: {
      moss: { ink: css(a.tagMossInk), bg: css(a.tagMossBg) },
      ochre: { ink: css(a.tagOchreInk), bg: css(a.tagOchreBg) },
      rosewood: { ink: css(a.tagRosewoodInk), bg: css(a.tagRosewoodBg) },
    },
  };
}

export const palettes: Record<SchemeName, Palette> = {
  light: build("light"),
  dark: build("dark"),
};

/**
 * The palette for one appearance — scheme × face.
 *
 * Paper's set is authored above (OKLCH, converted); ohmarchy's is generated from the same web
 * face (`./ohmarchy.ts`). Two palettes of ONE shape, chosen here, which is why no component
 * anywhere reads the face: it reads `theme.c`, as it always did.
 */
export function paletteOf(scheme: SchemeName, face: FaceName = DEFAULT_FACE): Palette {
  return face === "ohmarchy" ? ohmarchyPalettes[scheme] : palettes[scheme];
}
