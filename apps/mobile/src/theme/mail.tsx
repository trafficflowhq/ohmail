import { useMemo, type ReactNode } from "react";
import { design } from "@ohmail/tokens/design";
import { useTheme, type Theme } from "./index";
import { MailThemeContext } from "./mail-context";
import { css, oklch } from "./oklch";
import { nativePaperType, paperMailType } from "./type";
import { useMailFonts } from "./mail-fonts";

const paper = design.faces.paper.light;
export const calendarMark = "#2953FF";
const px = (value: string) => Number.parseFloat(value);
export const mailSize = {
  avatar: px(paper.av),
  edge: px(paper.s4),
  inset: px(paper.s2),
  rowInset: px(paper.s1),
  sheetRadius: px(paper["r-sheet"]),
  bar: px(paper["h-xl"]),
  back: px(paper["sheet-back-height"]),
  action: px(paper["h-m"]),
  dot: 12,
  row: px(paper.row) + px(paper.s4),
};

export function mailColors(theme: Pick<Theme, "scheme">) {
  return design.faces.paper[theme.scheme === "dark" ? "dark" : "light"];
}

export function avatarColors(address: string, theme: Pick<Theme, "scheme">) {
  let hash = 0x811c9dc5;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  const hues = design.avatarHues;
  const hue = hues[hash % hues.length]!;
  const tokens = mailColors(theme);
  const [bgLight, bgChroma] = tokens["av-bg"].split(" ").map(Number);
  const [fgLight, fgChroma] = tokens["av-fg"].split(" ").map(Number);
  return { background: css(oklch(bgLight!, bgChroma!, hue)), ink: css(oklch(fgLight!, fgChroma!, hue)) };
}

function projectMailTheme(theme: Theme, fontsReady: boolean): Theme {
  if (theme.face !== "paper") return theme;
  const colors = mailColors(theme);
  const type = { ...theme.type, ...paperMailType };
  return {
    ...theme,
    mail: true,
    c: {
      ...theme.c,
      canvas: colors.ground,
      panel: colors.sheet,
      float: colors.sheet,
      ink: colors.ink,
      ink2: colors.ink2,
      ink3: colors.ink3,
      hair: colors["ctl-ring"],
      hairSoft: colors.line,
      tint: colors.hover,
      tint2: colors["soft-sheet"],
      accent: colors.hot,
      accentInk: colors["hot-ink"],
      accentSoft: colors.wash,
      accentHair: colors.hot,
      onAccent: colors["on-hot"],
      scrim: colors.scrim,
      unreadWash: colors["sheet-new"],
      glass: colors.sheet,
      glassBrd: colors["btn-ring"],
      glassFlat: colors.sheet,
    },
    type: fontsReady ? nativePaperType(type) : type,
    radius: { ...theme.radius, row: px(paper["r-row"]), card: mailSize.sheetRadius, panel: mailSize.sheetRadius },
  };
}

export function MailAppearance({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const fontsReady = useMailFonts();
  const mailTheme = useMemo(() => theme.mail ? theme : projectMailTheme(theme, fontsReady), [theme, fontsReady]);
  return <MailThemeContext.Provider value={mailTheme}>{children}</MailThemeContext.Provider>;
}
