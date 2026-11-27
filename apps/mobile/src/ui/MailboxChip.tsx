import { StyleSheet, View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { Txt } from "./base";

export function MailboxChip({ label, withinRow = false, showDelivery = false }: {
  label: string; withinRow?: boolean; showDelivery?: boolean;
}) {
  const t = useTheme();
  const delivery = Copy.deliveredTo(label);
  return (
    <View
      accessible={withinRow ? undefined : true}
      accessibilityLabel={withinRow ? undefined : delivery}
      accessibilityElementsHidden={withinRow}
      importantForAccessibility={withinRow ? "no-hide-descendants" : undefined}
      style={{
        maxWidth: withinRow ? "30%" : "65%",
        flexShrink: withinRow ? 0 : 1,
        borderRadius: t.radius.pill,
        backgroundColor: t.mail ? t.c.hairSoft : t.c.tint2,
        paddingHorizontal: mailSize.inset,
        paddingVertical: withinRow ? 0 : StyleSheet.hairlineWidth,
      }}
    >
      <Txt variant="badge" tone="ink2" numberOfLines={1}>{showDelivery ? delivery : label}</Txt>
    </View>
  );
}
