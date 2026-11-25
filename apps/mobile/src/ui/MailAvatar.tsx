import { View } from "react-native";
import type { Address } from "../state/model";
import { useTheme } from "../theme";
import { avatarColors, mailSize } from "../theme/mail";
import { Copy } from "../copy";
import { Txt } from "./base";

function initialOf(person: Address) {
  return Array.from(person.name.trim() || person.address.trim())[0]?.toLocaleUpperCase();
}

export function MailAvatar({ person, unread, surface, additionalPeople, mailbox }: {
  person: Address;
  unread?: boolean;
  surface?: string;
  additionalPeople?: number;
  mailbox?: Address;
}) {
  const t = useTheme();
  const { background, ink } = avatarColors(person.address, t);
  const accountColors = mailbox ? avatarColors(mailbox.address, t) : null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: mailSize.avatar, height: mailSize.avatar, borderRadius: t.radius.pill,
        alignItems: "center", justifyContent: "center", backgroundColor: background,
      }}
    >
      <Txt variant="sectionLabel" numberOfLines={1} style={{ color: ink }}>{initialOf(person)}</Txt>
      {mailbox && accountColors ? (
        <View testID="mailbox-avatar-badge" style={{
          position: "absolute", right: -5, bottom: -5,
          width: mailSize.avatarBadge, height: mailSize.avatarBadge, borderRadius: t.radius.pill,
          alignItems: "center", justifyContent: "center", backgroundColor: accountColors.background,
          borderWidth: 2, borderColor: surface ?? t.c.panel,
        }}>
          <Txt variant="caption" numberOfLines={1} style={{ color: accountColors.ink }}>{initialOf(mailbox)}</Txt>
        </View>
      ) : null}
      {additionalPeople ? (
        <View style={{ position: "absolute", right: -4, ...(mailbox ? { top: -3 } : { bottom: -3 }), borderRadius: t.radius.pill,
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
