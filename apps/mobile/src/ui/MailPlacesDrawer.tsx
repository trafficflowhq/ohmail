import { useEffect } from "react";
import { BackHandler, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld } from "../state/world";
import { Button, Rule, Scroller } from "./base";
import { GlassSidebar } from "./glass/GlassSidebar";
import { MailCalendarSwitch } from "./MailCalendarSwitch";
import { MoreNav, Nav } from "./MoreNav";

export function MailPlacesDrawer({ open, active, onClose, onPlace, onCompose }: {
  open: boolean;
  active: string | null;
  onClose: () => void;
  onPlace: (place: string) => void;
  onCompose: () => void;
}) {
  const w = useWorld();
  const t = useTheme();
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
    { id: "screener", label: Copy.screener, icon: "screener", count: w.screener.waiting.length },
  ] as const;
  return (
    <GlassSidebar open={open} onClose={onClose} label={Copy.tabMore} compactPlaces>
      <Scroller avoidKeyboard contentStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}>
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingBottom: 12 }}>
          <Button label={Copy.mailWrite} icon="pen" variant="quiet" style={{ backgroundColor: t.c.tint2 }} onPress={() => { onClose(); onCompose(); }} />
        </View>
        <MailCalendarSwitch drawer onNavigate={onClose} />
        <Rule inset={20} />
        {places.map((place) => <Nav key={place.id} label={place.label} icon={place.icon}
          selected={active === place.id} count={place.count || undefined}
          onPress={() => { onClose(); onPlace(place.id); }} />)}
        <MoreNav onNavigate={onClose} drawer />
      </Scroller>
    </GlassSidebar>
  );
}
