/**
 * The segmented control — the prototype's `.seg`: a tint track with the active
 * segment lifted out of it on a float surface. Used for the Screener's three
 * shelves and for the appearance preference.
 */
import { useState } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";
import { useTheme } from "../theme";
import { SEGMENT_PAD, segmentFace, segmentPaint } from "./segment-face";
import { a11yRole } from "./a11y-role";
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
  disabled = false,
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
  /** Shown but not pressable — every segment dims and says so to a screen reader. */
  disabled?: boolean;
}) {
  const t = useTheme();
  /* A hidden copy measures each segment's label (the selected weight) and count; the face follows. */
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const put = (k: string) => (e: LayoutChangeEvent) => {
    const w = Math.ceil(e.nativeEvent.layout.width);
    setSizes((prev) => (prev[k] === w ? prev : { ...prev, [k]: w }));
  };
  const labelW = (i: number) => sizes[`l${i}`] ?? 0;
  const countW = (i: number) => (segments[i]!.count === undefined ? 0 : (sizes[`c${i}`] ?? 0) + 5);
  const paint = segmentPaint(t.scheme);
  const face = fill ? segmentFace(width, segments.map((_, i) => labelW(i) + countW(i))) : "equal";
  const stacked = face === "stacked";
  return (
    <View
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0) setWidth((prev) => (prev === w ? prev : w));
      }}
      style={[
        {
          flexDirection: "row",
          alignSelf: fill ? "auto" : "flex-start",
          backgroundColor: t.c[paint.track],
          borderRadius: t.radius.pill,
          padding: 3,
          gap: 2,
        },
        style,
      ]}
    >
      {fill ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", left: 0, top: 0, opacity: 0, flexDirection: "row", alignItems: "flex-start" }}
        >
          {segments.map((seg, i) => (
            <View key={seg.value} style={{ flexDirection: "row" }}>
              <Txt variant="settingsLabel" onLayout={put(`l${i}`)}>{seg.label}</Txt>
              {seg.count !== undefined ? <Txt variant="caption" tabular onLayout={put(`c${i}`)}>{seg.count}</Txt> : null}
            </View>
          ))}
        </View>
      ) : null}
      {segments.map((seg, i) => {
        const on = seg.value === value;
        const basis = face === "equal" ? null
          : { flexGrow: 1, flexShrink: 0, flexBasis: (stacked ? labelW(i) : labelW(i) + countW(i)) + SEGMENT_PAD };
        return (
          <Tap
            /* Keyed on the face: Android keeps a `flex` the next render removes, so a face change
               mounts the segment afresh rather than leaving it sized by the old rule. */
            key={`${seg.value}:${face}`}
            accessibilityRole={a11yRole("tab", Platform.OS === "ios" ? "ios" : "android")}
            accessibilityState={{ selected: on, disabled: disabled === true }}
            disabled={disabled === true}
            onPress={() => onChange(seg.value)}
            style={[
              {
                /* One sizing rule per face: `flex` would override the basis on the device. */
                ...(basis ?? { flex: fill ? 1 : 0 }),
                minHeight: stacked ? 44 : 34,
                flexDirection: stacked ? "column" : "row",
                alignItems: "center",
                justifyContent: "center",
                gap: stacked ? 0 : 5,
                borderRadius: t.radius.pill,
                paddingHorizontal: 8,
                backgroundColor: on ? t.c[paint.selected] : "transparent",
              },
              on ? t.lift("l1") : null,
              on && paint.ring ? { borderWidth: 1, borderColor: t.c.hair } : null,
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
