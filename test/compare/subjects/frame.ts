import type { Subject } from "../subject.js";
import { openFramePage } from "../../../packages/app/test/states/frame-page.js";

/**
 * The frame's own pictures where the reference draws none: each room (390, 719, 841, 1440) in each of the four
 * looks, in German on every one of them, and the one notice in the bar's place where no rail's foot stands. The
 * reference holds the rooms in paper light and the looks at the desktop's size, in English (`packages/app/test/compare/frame-parts.compare.ts`).
 */
export const ROOMS = [["phone", 390], ["fold", 719], ["foldl", 841], ["desktop", 1440]] as const;
export const LOOKS = [["paper", "light"], ["paper", "dark"], ["ohmarchy", "light"], ["ohmarchy", "dark"]] as const;

const query = (device: string, face: string, scheme: string, lang: "en" | "de", more = ""): string =>
  `device=${device}&face=${face}&lang=${lang}&scheme=${scheme}&screen=states${more}`;

const subjectsOf = (): Subject[] => {
  const out: Subject[] = [];
  for (const [device, width] of ROOMS) {
    for (const [face, scheme] of LOOKS) {
      for (const lang of ["en", "de"] as const) {
        /* The reference has this one: English, paper light in every room, and every look at the desktop's size. */
        if (lang === "en" && ((face === "paper" && scheme === "light") || device === "desktop")) continue;
        out.push({ key: `own:frame@${width}-${face}-${scheme}-${lang}`, open: (p) => openFramePage(p, query(device, face, scheme, lang)) });
      }
    }
  }
  for (const [device, width] of ROOMS.slice(0, 2)) {
    out.push({ key: `own:frame-noticebar@${width}`, open: (p) => openFramePage(p, query(device, "paper", "light", "en", "&show=full")) });
  }
  return out;
};

export const subjects: Subject[] = subjectsOf();
