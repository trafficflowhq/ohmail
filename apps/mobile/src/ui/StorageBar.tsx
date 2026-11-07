/**
 * The storage bar: what is stored, part by part, on a track scaled to the larger of the cap and what
 * the mail is expected to need; a tick where the cap stands. Tokens only.
 */
import { View } from "react-native";
import { useTheme } from "../theme";

export function StorageBar({ parts, scale, limit, height = 4 }: {
  /** Each part's size, in the scale's unit, drawn left to right. */
  parts: readonly number[];
  scale: number;
  /** Where the cap stands, in the same unit; no tick when absent. */
  limit?: number;
  height?: number;
}) {
  const t = useTheme();
  const share = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%` as const;
  return (
    <View style={{ height, backgroundColor: t.c.tint2, flexDirection: "row", overflow: "visible" }}>
      {parts.map((n, i) => (
        <View key={i} style={{ width: share(n), height, backgroundColor: i % 2 === 0 ? t.c.accent : t.c.accentInk }} />
      ))}
      {limit !== undefined && limit < scale ? (
        <View style={{ position: "absolute", left: share(limit), top: -3, width: 2, height: height + 6, backgroundColor: t.c.ink2 }} />
      ) : null}
    </View>
  );
}
