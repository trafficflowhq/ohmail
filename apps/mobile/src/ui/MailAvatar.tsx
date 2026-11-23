import { View } from "react-native";
import type { Address } from "../state/model";
import { useTheme } from "../theme";
import { avatarColors, mailSize } from "../theme/mail";
import { Copy } from "../copy";
import { Txt } from "./base";

export function MailAvatar({ person, unread, surface, additionalPeople }: { person: Address; unread?: boolean; surface?: string; additionalPeople?: number }) {
  const t = useTheme();
  const { background, ink } = avatarColors(person.address, t);
  const initial = Array.from(person.name.trim() || person.address.trim())[0]?.toLocaleUpperCase();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: mailSize.avatar, height: mailSize.avatar, borderRadius: t.radius.pill,
        alignItems: "center", justifyContent: "center", backgroundColor: background,
      }}
    >
      <Txt variant="sectionLabel" numberOfLines={1} style={{ color: ink }}>{initial}</Txt>
      {additionalPeople ? (
        <View style={{ position: "absolute", right: -4, bottom: -3, borderRadius: t.radius.pill,
          backgroundColor: t.c.tint2, paddingHorizontal: 3, borderWidth: 1, borderColor: surface ?? t.c.panel }}>
          <Txt variant="caption" tone="ink2">{Copy.rowMarksMore(additionalPeople)}</Txt>
        </View>
      ) : null}
      {unread ? (
        <View style={{
          position: "absolute", top: -4, left: -4,
          width: mailSize.dot + 4, height: mailSize.dot + 4, borderRadius: t.radius.pill,
          borderWidth: 2, borderColor: surface ?? t.c.panel, backgroundColor: t.c.accent,
        }} />
      ) : null}
    </View>
  );
}
