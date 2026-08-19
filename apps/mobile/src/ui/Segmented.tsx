/**
 * The segmented control — the prototype's `.seg`: a tint track with the active
 * segment lifted out of it on a float surface. Used for the Screener's three
 * shelves and for the appearance preference.
 */
import { View } from "react-native";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

export interface Segment<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  style,
  fill = true,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (v: T) => void;
  style?: object;
  /**
   * `true` (default) shares the width equally — right for a full-width shelf
   * switcher. `false` lets each segment size to its own label, which is what a
   * two-option control like the decision scope needs: equal thirds would clip
   * "whole domain" long before the screen ran out.
   */
  fill?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignSelf: fill ? "auto" : "flex-start",
          backgroundColor: t.c.tint2,
          borderRadius: t.radius.pill,
          padding: 3,
          gap: 2,
        },
        style,
      ]}
    >
      {segments.map((seg) => {
        const on = seg.value === value;
        return (
          <Tap
            key={seg.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(seg.value)}
            style={[
              {
                flex: fill ? 1 : 0,
                minHeight: 34,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                borderRadius: t.radius.pill,
                paddingHorizontal: 8,
                backgroundColor: on ? t.c.float : "transparent",
              },
              on ? t.lift("l0") : null,
            ]}
          >
            <Txt variant={on ? "settingsLabel" : "navLabel"} tone={on ? "ink" : "ink3"} numberOfLines={1}>
              {seg.label}
            </Txt>
            {seg.count !== undefined ? (
              <Txt variant="caption" tone={on ? "ink3" : "ink3"} tabular>
                {seg.count}
              </Txt>
            ) : null}
          </Tap>
        );
      })}
    </View>
  );
}
