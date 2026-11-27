import { design } from "@ohmail/tokens/design";
import { View } from "react-native";
import { Copy } from "../copy";
import { useTheme, type FaceName } from "../theme";
import { avatarColors, mailSize } from "../theme/mail";
import { useMailFonts } from "../theme/mail-fonts";
import { Txt } from "./base";

const size = (value: string) => Number.parseFloat(value);

/** The two example messages in the web's appearance tiles. */
const messages = [
  { who: "Anna Berger", time: "09:12" },
  { who: "Tom Keller", time: "08:47" },
] as const;

export function SettingsLookPreview({ face }: { face: FaceName }) {
  const theme = useTheme();
  const fonts = useMailFonts();
  const c = design.faces[face][theme.scheme];
  const paper = face === "paper";
  const body = fonts ? { fontFamily: paper ? "PaperBody700" : "PaperMono500", fontWeight: undefined } : undefined;
  const title = fonts ? { fontFamily: paper ? "PaperDisplay" : "PaperMono500", fontWeight: undefined } : undefined;
  const round = size(c["av-r"]);
  const marker = size(c["dot-size"]) * size(c["t-title"]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
      height: 156, backgroundColor: c.ground, borderRadius: size(c["r-row"]),
      paddingTop: size(c.s3), paddingHorizontal: size(c.s3), overflow: "hidden",
    }}>
      <View style={{
        flex: 1, backgroundColor: c.sheet, borderTopLeftRadius: size(c["r-sheet"]),
        borderTopRightRadius: size(c["r-sheet"]), paddingHorizontal: size(c.s2), paddingTop: size(c.s3),
        borderWidth: size(c.ringw), borderColor: c.ring,
      }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 2,
          paddingLeft: size(c.s1) + size(c.gutter), marginBottom: size(c.s2) }}>
          <Txt variant={paper ? "cardTitle" : "bodyMedium"} style={[{ color: c.ink }, title]}>{Copy.ohbox}</Txt>
          <View style={{ width: marker, height: marker, borderRadius: size(c["dot-r"]), backgroundColor: c.hot }} />
        </View>
        {messages.map(({ who, time }, i) => {
          const open = i === 0;
          const avatar = avatarColors(who, theme);
          const circle = size(c["av-s"]);
          return (
            <View key={who} style={{
              flexDirection: "row", alignItems: "center", minHeight: size(c["h-l"]),
              paddingLeft: size(c.s1), paddingRight: size(c.s3), borderRadius: size(c["r-row"]),
              backgroundColor: open ? c["row-open"] : undefined,
            }}>
              <View style={{ width: size(c.gutter), paddingLeft: size(c.s2) }}>
                <View style={{
                  width: circle, height: circle, borderRadius: round, justifyContent: "center", alignItems: "center",
                  backgroundColor: open && paper ? c.sheet : avatar.background,
                  borderWidth: size(c["av-ring"]), borderColor: c["btn-ring"],
                }}>
                  <Txt variant="caption" style={[{ color: open && paper ? c.ink : avatar.ink }, title]}>{who[0]}</Txt>
                  <View style={{
                    position: "absolute", left: -3, top: -3, width: paper ? 10 : 8, height: paper ? 10 : 8,
                    borderRadius: size(c["dot-r"]), backgroundColor: open ? c["row-open-dot"] : c.hot,
                  }} />
                </View>
              </View>
              <Txt variant={paper ? "bodyMedium" : "caption"} numberOfLines={1}
                style={[{ flex: 1, color: open ? c["on-row-open"] : c.ink }, body]}>
                {who}
              </Txt>
              <Txt variant="meta" tabular style={{ marginLeft: mailSize.inset, color: open ? c["on-row-open2"] : c.ink2 }}>
                {time}
              </Txt>
            </View>
          );
        })}
      </View>
    </View>
  );
}
