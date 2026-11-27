import { useContext } from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { MailThemeContext } from "../theme/mail-context";
import { onboardingLook, points } from "../theme/onboarding";

/** The mail kit's inline full stop. The last word and the mark share a line. */
export function HeadingEnd({ children, variant, hot = false, show = true }: {
  children: string;
  variant: "h1" | "h2" | "caption" | "sectionLabel";
  hot?: boolean;
  show?: boolean;
}) {
  const t = useTheme();
  const mail = useContext(MailThemeContext);
  if (!show || (!t.mail && mail === null)) return children;
  const { type } = onboardingLook({ face: t.face ?? "paper", scheme: t.scheme });
  const fontSize = t.type?.[variant]?.fontSize ?? 0;
  const size = fontSize * points(type["dot-size"]);
  const words = children.trimEnd().replace(/(?<!\.)\.$/u, "");
  return (
    <>
      {words}{"\u2060"}
      <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{
          width: size, height: size, marginLeft: fontSize * 0.08,
          borderRadius: Math.min(size / 2, points(type["dot-r"])),
          backgroundColor: hot ? t.c.accent : t.c.ink,
        }}
      />
    </>
  );
}
