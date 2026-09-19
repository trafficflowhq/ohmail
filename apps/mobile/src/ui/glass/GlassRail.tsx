/**
 * The vertical rail — the Duo's edge column and Material's leading rail, one component: glass
 * pills of round buttons, TOP-ALIGNED (Apple: primary navigation at the top of the vertical
 * axis, groups kept distinct), 62pt wide. The column is BUDGETED against its height: what does
 * not fit folds bottom-to-top into ⋯ (`fold.ts#railFold`), items
 * marked `fixed` never fold, and the folded verbs stay reachable in a sheet — nothing ever
 * clips. Until the first measurement the whole column renders; the fold applies on the next
 * frame, the bar-density lesson in the other axis.
 */
import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { useTheme } from "../../theme";
import { Copy } from "../../copy";
import type { IconName } from "../Icon";
import { Sheet, SheetRow } from "../Sheet";
import { railFold, type RailEntry } from "./fold";
import { GlassIconButton } from "./GlassIconButton";
import { GlassPill } from "./GlassPill";

export interface RailAction extends RailEntry {
  icon?: IconName;
  /** A textual mark where no icon exists (⋯). */
  glyph?: string;
  label: string;
  badge?: number;
  badgeHot?: boolean;
  on?: boolean;
  accent?: boolean;
  role?: "button" | "tab";
  onPress?: () => void;
}

export const RAIL_WIDTH = 62;

export function GlassRail({
  groups,
  foldInto = "sheet",
}: {
  /** Pill groups, top to bottom. Order is fold order — the last non-fixed item folds first. */
  groups: readonly (readonly RailAction[])[];
  /**
   * Where folded items go: a ⋯ pill opening a sheet (the reader rail), or nowhere visible
   * because a More destination in the column already reaches them (the nav rail).
   */
  foldInto?: "sheet" | "none";
}) {
  const t = useTheme();
  const [availH, setAvailH] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const measured = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setAvailH((prev) => (prev !== null && Math.abs(prev - h) < 0.5 ? prev : h));
  };

  const byId = new Map<string, RailAction>();
  for (const g of groups) for (const a of g) byId.set(a.id, a);

  const fold = availH === null ? { kept: groups.map((g) => [...g]), folded: [] } : railFold(groups, availH);
  const folded = fold.folded.map((e) => byId.get(e.id)).filter((a): a is RailAction => a !== undefined);

  return (
    <View
      onLayout={measured}
      style={{ width: RAIL_WIDTH, flex: 1, alignItems: "center", gap: 10 }}
    >
      {fold.kept.map((group, gi) => (
        <GlassPill key={gi}>
          {group.map((entry) => {
            const a = byId.get(entry.id);
            if (a === undefined) return null;
            return (
              <GlassIconButton
                key={a.id}
                icon={a.icon}
                glyph={a.glyph}
                label={a.label}
                on={a.on}
                accent={a.accent}
                badge={a.badge}
                badgeHot={a.badgeHot}
                role={a.role}
                onPress={a.onPress}
              />
            );
          })}
        </GlassPill>
      ))}
      {foldInto === "sheet" && folded.length > 0 ? (
        <GlassPill>
          <GlassIconButton glyph="⋯" label={Copy.tabMore} onPress={() => setMoreOpen(true)} />
        </GlassPill>
      ) : null}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label={Copy.tabMore}>
        {folded.map((a) => (
          <SheetRow
            key={a.id}
            label={a.label}
            icon={a.icon}
            on={a.on}
            onPress={() => {
              setMoreOpen(false);
              a.onPress?.();
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}
