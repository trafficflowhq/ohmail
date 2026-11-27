import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { Section, Tap, Txt } from "./base";
import { NavigationIcon } from "./Icon";

export function DrawerGroup({ active, label, collapsed = false, selected = false, children }: { active: boolean; label: string; collapsed?: boolean; selected?: boolean; children: ReactNode }) {
  const t = useTheme();
  const [open, setOpen] = useState(!collapsed || selected);
  if (!active) return <><Section>{label}</Section>{children}</>;
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12 }}>
        <View style={{ width: 20, alignItems: "center", transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
          <NavigationIcon name="down" size={16} color={t.c.ink3} />
        </View>
        <Txt variant="railLabel">{label}</Txt>
      </Tap>
      <View style={open ? undefined : { display: "none" }} accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}>{children}</View>
    </>
  );
}
