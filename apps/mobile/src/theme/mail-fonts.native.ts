import { useFonts } from "expo-font";

const fonts = {
  PaperDisplay: require("@ohmail/tokens/fonts/bricolage-800.ttf"),
  PaperBody400: require("@ohmail/tokens/fonts/hanken-400.ttf"),
  PaperBody500: require("@ohmail/tokens/fonts/hanken-500.ttf"),
  PaperBody600: require("@ohmail/tokens/fonts/hanken-600.ttf"),
  PaperBody700: require("@ohmail/tokens/fonts/hanken-700.ttf"),
  PaperMono400: require("@ohmail/tokens/fonts/jetbrains-400.ttf"),
  PaperMono500: require("@ohmail/tokens/fonts/jetbrains-500.ttf"),
};

export function useMailFonts(): boolean {
  const [loaded] = useFonts(fonts);
  return loaded;
}
