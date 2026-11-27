import { useEffect } from "react";
import { router } from "expo-router";
import { BackHandler, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { design } from "@ohmail/tokens/design";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { mailColors } from "../theme/mail";
import { useWorld } from "../state/world";
import { usePrefs } from "../state/store";
import { usePullToSync, type PullToSync } from "../state/pull";
import { Scroller, Tap, Txt } from "./base";
import { GlassSidebar } from "./glass/GlassSidebar";
import { MailAvatar } from "./MailAvatar";
import { MailCalendarSwitch } from "./MailCalendarSwitch";
import { MoreNav, Nav } from "./MoreNav";
import { NavigationIcon } from "./Icon";

const paper = design.faces.paper.phone;
const paperEdge = Number.parseFloat(paper.edge);
const railGap = Number.parseFloat(paper.s3);
const writeHeight = Number.parseFloat(paper["h-l"]);

export function MailPlacesDrawer({ open, active, onClose, onPlace, onCompose }: {
  open: boolean;
  active: string | null;
  onClose: () => void;
  onPlace: (place: string) => void;
  onCompose: () => void;
}) {
  const w = useWorld();
  const t = useTheme();
  const colors = mailColors(t);
  const pull = usePullToSync();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);
  if (!open) return null;

  const places = [
    { id: "index", label: Copy.ohbox, icon: "ohbox", count: w.ohbox.unread },
    { id: "reads", label: Copy.reads, icon: "reads", count: w.reads.newCount },
    { id: "receipts", label: Copy.receipts, icon: "receipts", count: w.receipts.newCount },
  ] as const;
  return (
    <GlassSidebar open={open} onClose={onClose} label={Copy.tabMore} compactPlaces>
      <View style={{ flex: 1, paddingHorizontal: paperEdge, paddingTop: insets.top + paperEdge }}>
        <Tap accessibilityRole="button" accessibilityLabel={Copy.mailWrite}
          onPress={() => { onClose(); onCompose(); }}
          style={{ alignSelf: "flex-start", minHeight: writeHeight,
            paddingLeft: Number.parseFloat(paper.s4), paddingRight: Number.parseFloat(paper.s5),
            borderRadius: t.radius.pill, flexDirection: "row", alignItems: "center",
            gap: Number.parseFloat(paper.s2), backgroundColor: colors["soft-sheet"], marginBottom: Number.parseFloat(paper.s4) }}>
          <NavigationIcon name="pen" color={colors.ink} />
          <Txt variant="button">{Copy.mailWrite}</Txt>
        </Tap>
        <Scroller avoidKeyboard contentStyle={{ paddingTop: 0, paddingHorizontal: 0, paddingBottom: insets.bottom + paperEdge, gap: railGap }}>
          <MailCalendarSwitch drawer onNavigate={onClose} />
          <View style={{ gap: 2 }}>
            {places.map((place) => <Nav key={place.id} label={place.label} drawer drawerIcon={place.icon}
              selected={active === place.id} count={place.count || undefined}
              onPress={() => { onClose(); onPlace(place.id); }} />)}
          </View>
          <Nav label={Copy.screener} drawer drawerIcon="screener"
            selected={active === "screener"} count={w.screener.waiting.length || undefined}
            onPress={() => { onClose(); onPlace("screener"); }} />
          <MoreNav onNavigate={onClose} selected={active} drawer />
          <DrawerFooter onClose={onClose} pull={pull} />
        </Scroller>
      </View>
    </GlassSidebar>
  );
}

function DrawerFooter({ onClose, pull }: { onClose: () => void; pull: PullToSync }) {
  const { account, mailboxes } = useWorld();
  const t = useTheme();
  const { setTheme } = usePrefs();
  const first = mailboxes.rows[0];
  const address = first?.address || account.email;
  const name = first?.displayName?.trim() || address || account.name;
  const note = mailboxes.known ? Copy.mailboxCountWaiting(mailboxes.rows.length) : "";
  const dark = t.scheme === "dark";
  const pullLabel = pull.refreshing ? Copy.selfCheckChecking : pull.result ?? Copy.drawerPullMail;
  return (
    <View style={{ gap: 4 }}>
      <Tap accessibilityRole="button" accessibilityLabel={pullLabel}
        accessibilityState={{ busy: pull.refreshing }} onPress={pull.onRefresh}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: railGap,
          minHeight: Number.parseFloat(paper["h-m"]), borderRadius: t.radius.pill,
          backgroundColor: pressed ? t.c.tint2 : undefined,
        })}>
        <NavigationIcon name="pull" color={t.c.ink2} />
        <Txt variant="body" tone="ink2" accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}>{pullLabel}</Txt>
      </Tap>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end" }}>
        {name ? (
          <Tap accessibilityRole="button" accessibilityLabel={note ? Copy.ariaLabelDetail(name, note) : name}
            onPress={() => {
              onClose();
              router.push({ pathname: "/settings", params: { pane: "mailboxes" } });
            }}
            style={{ flex: 1, minHeight: 48, flexDirection: "row", gap: 10, alignItems: "center", paddingHorizontal: railGap }}>
            <MailAvatar person={{ name, address }} size={Number.parseFloat(paper["av-s"])} />
            <View style={{ flex: 1 }}>
              <Txt variant="rowSender" numberOfLines={1}>{name}</Txt>
              {note ? <Txt variant="caption" tone="ink2" numberOfLines={1}>{note}</Txt> : null}
            </View>
          </Tap>
        ) : null}
        <Tap accessibilityRole="button" accessibilityLabel={dark ? Copy.themeLight : Copy.themeDark}
          onPress={() => setTheme(dark ? "light" : "dark")}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <NavigationIcon name={dark ? "sun" : "moon"} color={t.c.ink2} />
        </Tap>
      </View>
    </View>
  );
}
