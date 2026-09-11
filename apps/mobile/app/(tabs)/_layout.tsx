/**
 * The tab bar — the desktop dock, adapted to a thumb.
 *
 * Blanc's dock is a floating capsule held up by `lift-3`, not a bar welded to
 * the bottom edge. It floats above the home indicator, the canvas runs under
 * it, and every scroller reserves `space.tabClearance` so a panel's shadow
 * falloff is never sheared by it. Five destinations: the three mail places,
 * the Screener, and the route out to everything the desktop rail holds below
 * the fold.
 */
import { Tabs } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/theme";
import { useWorld } from "../../src/state/world";
import { Gated } from "../../src/ui/Gated";
import { Icon, type IconName } from "../../src/ui/Icon";
import { Tap, Txt } from "../../src/ui/base";
import { FadeOut } from "../../src/ui/FadeOut";
import { Copy } from "../../src/copy";
import { useLocale } from "../../src/i18n/LocaleProvider";

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

/*
 * The five tab names read from the deck through GETTERS, not as captured strings. This table is
 * built at module scope, long before a language is resolved, so a plain string here would be the
 * language the process started in for the rest of its life — which is exactly what it was: two of
 * the five ("Receipts" and "More") stayed English under a German interface, and the other three
 * are the same word in both languages, so nothing looked wrong enough to notice.
 */
const TABS: { name: string; readonly label: string; icon: IconName }[] = [
  { name: "index", get label() { return Copy.ohbox; }, icon: "ohbox" },
  { name: "screener", get label() { return Copy.screener; }, icon: "door" },
  { name: "reads", get label() { return Copy.reads; }, icon: "reads" },
  { name: "receipts", get label() { return Copy.receipts; }, icon: "receipts" },
  { name: "more", get label() { return Copy.tabMore; }, icon: "more" },
];

export default function TabsLayout() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: "transparent" } }}
        tabBar={(props) => <Dock {...props} />}
      >
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
        ))}
      </Tabs>
    </Gated>
  );
}

function Dock({ state, navigation }: DockProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();

  /**
   * The engine's counts over the mirror, not a third derivation computed here.
   * Both streams read `newCount`, `FeedPartition`'s own field (above this
   * device's waterline and still unread on the server) — the same number the
   * browser and desktop rails show, so one account cannot report two counts
   * for one pile. Counting `items.filter(unread)` here was a third answer, and
   * once a resurfaced row is drawn unread (`presentsUnread`, via `toMail`) it
   * counted pins as new mail. What is drawn and what is counted are different
   * questions; `WorldMail.unread` answers the first, these fields the second.
   */
  const badgeOf: Record<string, number> = {
    index: w.ohbox.unread,
    screener: w.screener.waiting.length,
    reads: w.reads.newCount,
    receipts: w.receipts.newCount,
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
              accessibilityLabel={count ? Copy.ariaLabelCount(tab.label, count) : tab.label}
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
