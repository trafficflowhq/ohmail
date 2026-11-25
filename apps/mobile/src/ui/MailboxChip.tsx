import { View } from "react-native";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { Txt } from "./base";

export function MailboxChip({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        maxWidth: "30%",
        flexShrink: 0,
        borderRadius: t.radius.pill,
        backgroundColor: t.c.tint2,
        paddingHorizontal: mailSize.inset,
      }}
    >
      <Txt variant="badge" tone="ink2" numberOfLines={1}>{label}</Txt>
    </View>
  );
}
