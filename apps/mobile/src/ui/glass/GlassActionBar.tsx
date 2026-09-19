/**
 * The desktop reader's ActionBar in the glass grammar — pinned at the reading pane's foot on
 * every big flat surface (the caller owns the pinning). The arrangement is the webapp's
 * (`MessagePane.tsx` + `bar-density.ts`): Reply the one accent capsule, then the verbs IN ROW
 * ORDER — Reply all, Forward, the Not-now segment, Tag, the File-it segment — the read switch
 * beside them, ⋯ last. ROW ORDER IS FOLD ORDER: verbs are admitted greedily while they fit
 * (`fold.ts#admitVerbs`), a later verb never stands while an earlier one folds, a folded verb
 * is in the ⋯ sheet — in the row or behind More, never both, never clipped. A hidden copy of
 * every capsule measures itself; until then the row is its floor — Reply, the read switch, ⋯.
 */
import { useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useTheme } from "../../theme";
import { Copy } from "../../copy";
import { Icon, type IconName } from "../Icon";
import { Sheet, SheetRow } from "../Sheet";
import { Tap } from "../base";
import { admitVerbs, type BarVerbBox } from "./fold";
import { GlassPill } from "./GlassPill";

export interface BarVerbSpec {
  id: string;
  label: string;
  icon?: IconName;
  /** The segmented control this verb belongs to — members abut and read as one control. */
  seg?: "defer" | "file" | null;
  onPress: () => void;
}

const GAP = 4;

export function GlassActionBar({
  reply,
  verbs,
  readSwitch,
  extraMore = [],
}: {
  /** The one solid capsule. Never folds. */
  reply?: { label: string; onPress: () => void } | null;
  /** Row order = fold order — the webapp's BAR_VERB_ORDER, supplied by the surface. */
  verbs: readonly BarVerbSpec[];
  /** The read state, beside the verbs, never folded — Done / Mark unread. */
  readSwitch?: { label: string; onPress: () => void } | null;
  /** Verbs that always live behind ⋯, after whatever folded. */
  extraMore?: readonly BarVerbSpec[];
}) {
  const t = useTheme();
  const [room, setRoom] = useState<number | null>(null);
  const [measured, setMeasured] = useState<Record<string, number> | null>(null);
  const widths = useRef<Record<string, number>>({});
  const [moreOpen, setMoreOpen] = useState(false);

  const need = verbs.length + (reply ? 1 : 0) + (readSwitch ? 1 : 0) + 1;
  const record = (id: string) => (e: LayoutChangeEvent) => {
    widths.current[id] = e.nativeEvent.layout.width;
    if (Object.keys(widths.current).length >= need) setMeasured({ ...widths.current });
  };

  const boxes: BarVerbBox[] = verbs.map((v) => ({
    id: v.id,
    width: measured?.[v.id] ?? 0,
    seg: v.seg ?? null,
  }));
  const fixedWidth =
    (reply ? (measured?.["__reply"] ?? 0) + GAP : 0) +
    (readSwitch ? (measured?.["__read"] ?? 0) + GAP : 0) +
    (measured?.["__more"] ?? 0) +
    2 * 6; /* the pill's own padding */
  const admitted =
    room === null || measured === null ? 0 : admitVerbs(boxes, room, fixedWidth, GAP);
  const standing = verbs.slice(0, admitted);
  const folded = [...verbs.slice(admitted), ...extraMore];

  /** One verb capsule — `.abar-b`: 44pt touch box, icon 13, the segment track behind members. */
  const capsule = (v: BarVerbSpec, opts?: { measure?: boolean }) => (
    <Tap
      key={v.id}
      accessibilityRole="button"
      accessibilityLabel={v.label}
      onPress={opts?.measure ? undefined : v.onPress}
      onLayout={opts?.measure ? record(v.id) : undefined}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        minHeight: 44,
        paddingHorizontal: 12,
        borderRadius: t.radius.pill,
        backgroundColor: pressed && !opts?.measure ? t.c.tint : "transparent",
      })}
    >
      {v.icon ? <Icon name={v.icon} size={13} color={t.c.ink2} /> : null}
      <Text style={[t.type.button, { color: t.c.ink2 }]} numberOfLines={1}>
        {v.label}
      </Text>
    </Tap>
  );

  const solid = (label: string, onPress?: () => void, measure?: (e: LayoutChangeEvent) => void) => (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLayout={measure}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: t.radius.pill,
        backgroundColor: t.c.accent,
        opacity: pressed && !measure ? 0.86 : 1,
      })}
    >
      <Text style={[t.type.button, { color: t.c.onAccent }]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );

  const more = (measure?: (e: LayoutChangeEvent) => void) => (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={Copy.tabMore}
      onPress={measure ? undefined : () => setMoreOpen(true)}
      onLayout={measure}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 40,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: t.radius.pill,
        backgroundColor: pressed && !measure ? t.c.tint : "transparent",
      })}
    >
      <Text style={[t.type.button, { color: t.c.ink2, fontWeight: "700", letterSpacing: 0.5 }]}>⋯</Text>
    </Tap>
  );

  /** Consecutive same-segment verbs share the tint track, the prototype's `.abar-g.seg`. */
  const grouped: { seg: string | null; run: BarVerbSpec[] }[] = [];
  for (const v of standing) {
    const seg = v.seg ?? null;
    const last = grouped[grouped.length - 1];
    if (last !== undefined && last.seg !== null && last.seg === seg) last.run.push(v);
    else grouped.push({ seg, run: [v] });
  }

  return (
    <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)} style={{ alignItems: "center" }}>
      {/* The hidden copy every width is read from — same capsules, absolute, invisible. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", opacity: 0, flexDirection: "row", left: 0, top: 0 }}
      >
        {reply ? solid(reply.label, undefined, record("__reply")) : null}
        {verbs.map((v) => capsule(v, { measure: true }))}
        {readSwitch ? capsule({ id: "__read", label: readSwitch.label, onPress: () => {} }, { measure: true }) : null}
        {more(record("__more"))}
      </View>

      <GlassPill horizontal level="l3" contentStyle={{ gap: GAP, paddingHorizontal: 6 }}>
        {reply ? solid(reply.label, reply.onPress) : null}
        {grouped.map((g, i) =>
          g.seg !== null && g.run.length > 1 ? (
            <View
              key={`seg-${i}`}
              accessibilityRole="none"
              style={{
                flexDirection: "row",
                backgroundColor: t.c.tint,
                borderRadius: t.radius.pill,
                padding: 2,
              }}
            >
              {g.run.map((v) => capsule(v))}
            </View>
          ) : (
            g.run.map((v) => capsule(v))
          ),
        )}
        {readSwitch ? capsule({ id: "__read", label: readSwitch.label, onPress: readSwitch.onPress }) : null}
        {more()}
      </GlassPill>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label={Copy.tabMore}>
        {folded.map((v) => (
          <SheetRow
            key={v.id}
            label={v.label}
            icon={v.icon}
            onPress={() => {
              setMoreOpen(false);
              v.onPress();
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}
