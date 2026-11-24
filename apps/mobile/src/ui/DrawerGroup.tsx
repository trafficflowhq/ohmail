import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { Section, Tap, Txt } from "./base";
import { Icon } from "./Icon";

export function DrawerGroup({ active, label, collapsed = false, children }: { active: boolean; label: string; collapsed?: boolean; children: ReactNode }) {
  const t = useTheme();
  const [open, setOpen] = useState(!collapsed);
  if (!active) return <><Section>{label}</Section>{children}</>;
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12 }}>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chev" size={12} color={t.c.ink3} />
        </View>
        <Txt variant="rowSender">{label}</Txt>
      </Tap>
      <View style={open ? undefined : { display: "none" }} accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}>{children}</View>
    </>
  );
}
