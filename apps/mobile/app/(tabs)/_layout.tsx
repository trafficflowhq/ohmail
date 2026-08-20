/**
 * The tab bar — the desktop dock, adapted to a thumb.
 *
 * Blanc's dock is a floating capsule held up by `lift-3`, not a bar welded to
 * the bottom edge; keeping that shape is what stops the app reading like a
 * default RN template. It floats above the home indicator, the canvas runs
 * underneath it, and every scroller reserves `space.tabClearance` so a panel's
 * shadow falloff is never sheared by it.
 *
 * Five destinations, because five is what the product has: the three mail
 * places, the Screener, and the route out to everything the desktop rail holds
 * below the fold (piles, tags, search, settings).
 */
import { Redirect, Tabs } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../../src/copy";
import { useConnection } from "../../src/net/connection";
import { gateFor } from "../../src/state/gate";
import { useTheme } from "../../src/theme";
import { useWorld } from "../../src/state/world";
import { Icon, type IconName } from "../../src/ui/Icon";
import { Screen, Tap, Txt } from "../../src/ui/base";
import { FadeOut } from "../../src/ui/FadeOut";

/**
 * The slice of the navigator's tab-bar props this dock uses. Typed here rather
 * than imported from `@react-navigation/bottom-tabs`: that package is a
 * transitive dependency of `expo-router` and pnpm's isolated store does not
 * expose it to this workspace, so importing its types would couple the build
 * to a hoisting accident.
 */
interface DockProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (event: {
      type: "tabPress";
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: "index", label: "Ohbox", icon: "ohbox" },
  { name: "screener", label: "Screener", icon: "door" },
  { name: "reads", label: "Reads", icon: "reads" },
  { name: "receipts", label: "Receipts", icon: "receipts" },
  { name: "more", label: "More", icon: "more" },
];

export default function TabsLayout() {
  const conn = useConnection();
  const verdict = gateFor(conn.state, conn.profiles.length);

  // NOT CONNECTED → the connect flow owns the screen; the mail UI renders only a live
  // mirror. `boot` paints nothing for the instant before the keystore answers, so a
  // paired phone never flashes the welcome screen on its way to mail.
  if (verdict.to === "boot") return <Screen>{null}</Screen>;
  if (verdict.to === "welcome") return <Redirect href="/welcome" />;
  if (verdict.to === "servers") return <Redirect href="/servers" />;
  if (verdict.to === "connecting") return <ConnectingView origin={verdict.origin} />;

  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: "transparent" } }}
      tabBar={(props) => <Dock {...props} />}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}

/** A boot or switch in flight — one sentence, not the mail UI and not a spinner circus. */
function ConnectingView({ origin }: { origin: string }) {
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 8 }}>
        <Txt variant="settingsLabel">{origin}</Txt>
        <Txt variant="caption" tone="ink3">
          {Copy.connectBooting}
        </Txt>
      </View>
    </Screen>
  );
}

function Dock({ state, navigation }: DockProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();

  // The world's own numbers — the engine's counts over the mirror.
  const badgeOf: Record<string, number> = {
    index: w.ohbox.unread,
    screener: w.screener.waiting.length,
    reads: w.reads.items.filter((m) => m.unread).length,
    receipts: w.receipts.groups.reduce((n, g) => n + g.items.filter((m) => m.unread).length, 0),
    more: 0,
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        // Exactly the band every scroller reserves (`Scroller` pads by
        // `tabClearance + insets.bottom`), so the fade covers the reserved
        // room and not one point more. Explicit rather than content-derived:
        // Android clips absolutely-positioned children that exceed a parent
        // whose height came from its content.
        height: t.space.tabClearance + insets.bottom,
        justifyContent: "flex-end",
        zIndex: t.zLayer.tabBar,
      }}
    >
      {/*
       * The canvas, reasserted under the dock. A floating capsule means the
       * scroller runs beneath it and on into the home-indicator band, where a
       * stranded half-row reads as a clipping bug rather than as "there is
       * more". `space.tabClearance` is exactly the room every scroller already
       * reserves, so the fade covers the reserved band and nothing else; it
       * turns solid before the capsule so the strip below the dock is canvas.
       */}
      <FadeOut color={t.c.canvas} height={t.space.tabClearance + insets.bottom} solidFrom={0.55} />

      <View
        style={[
          {
            flexDirection: "row",
            backgroundColor: t.c.float,
            borderRadius: t.radius.pill,
            paddingVertical: 8,
            paddingHorizontal: 6,
            marginHorizontal: 12,
            marginBottom: Math.max(insets.bottom, 10),
          },
          t.lift("l3"),
        ]}
      >
        {state.routes.map((route, i) => {
          const tab = TABS.find((x) => x.name === route.name);
          if (!tab) return null;
          const active = state.index === i;
          const count = badgeOf[route.name] ?? 0;
          const hot = route.name === "screener" || route.name === "index";
          return (
            <Tap
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={count ? `${tab.label}, ${count}` : tab.label}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!active && !event.defaultPrevented) navigation.navigate(route.name);
              }}
              style={{ flex: 1, alignItems: "center", gap: 3, paddingVertical: 4, minHeight: 44 }}
            >
              <View>
                <Icon
                  name={tab.icon}
                  size={19}
                  weight={active ? 1.7 : 1.3}
                  color={active ? t.c.accentInk : t.c.ink3}
                />
                {count > 0 ? (
                  <View
                    style={{
                      position: "absolute",
                      top: -7,
                      right: -13,
                      minWidth: 16,
                      height: 16,
                      paddingHorizontal: 4,
                      borderRadius: t.radius.pill,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: hot ? t.c.accent : t.c.tint2,
                    }}
                  >
                    <Txt variant="tagchip" tone={hot ? "onAccent" : "ink3"} tabular>
                      {count}
                    </Txt>
                  </View>
                ) : null}
              </View>
              <Txt variant="tabLabel" tone={active ? "accent" : "ink3"} numberOfLines={1}>
                {tab.label}
              </Txt>
            </Tap>
          );
        })}
      </View>
    </View>
  );
}
